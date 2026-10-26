// 復習画面(src/client/Review.tsx)を実画面として描画し、実 API(workerd + ローカル D1)に繋いで動かす。
// 画面の fetch をそのまま Worker(Hono)へ渡し、ブラウザと Access の代わりに Origin と JWT を足す
//(差し替えるのは JWKS 取得関数だけ = test/access-harness.ts。検証経路は本番と同じ)。
//
// ここで押さえること(Issue 5):
//  - 応答が消えたあとの再送で二重評価にならない(同じ review_id で送る)
//  - 409 なら due を取り直して続ける
//  - 認証切れ(401)は再ログインを案内し、再送ループにしない
//  - 短期カード(学習ステップ)の待ち時間を出し、時間が来たら出し直す(固定時計)
//  - 送信中は評価ボタンが無効

import { env } from "cloudflare:workers";
import { h } from "preact";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/client/App";
import type { ImportResponse } from "../src/shared/cards";
import type { DueResponse } from "../src/shared/review";
import { toUtcIso } from "../src/worker/time";
import { type AccessHarness, createAccessHarness, ORIGIN } from "./access-harness";
import { buttonByText, byTag, click, flush, mount, textOf } from "./dom";

// 固定時計(JST では 2026-10-26 10:23)。Date と setInterval だけを偽物にする
//(flush() の setTimeout は本物のまま使いたい)。
const NOW = new Date("2026-10-26T01:23:45.000Z");
const MINUTE = 60 * 1000;

const RATING_LABELS = ["Again", "Hard", "Good", "Easy"];

interface SentCall {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

type Behave = (call: SentCall, send: () => Promise<Response>) => Promise<Response>;

let harness: AccessHarness;
/** 画面の送信に載せる Access JWT(null = セッションが切れた状態)。 */
let jwt: string | null = null;
/** 画面が送った要求(順番どおり)。 */
let calls: SentCall[] = [];

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
  harness = await createAccessHarness(NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(async () => {
  vi.setSystemTime(NOW);
  jwt = harness.jwt;
  calls = [];
  await env.DB.batch([
    env.DB.prepare("DELETE FROM reviews"),
    env.DB.prepare("DELETE FROM card_state"),
    env.DB.prepare("DELETE FROM cards"),
    env.DB.prepare("DELETE FROM imports"),
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 画面の fetch を実 Worker に繋ぐ。`behave` で通信の失敗や遅れを作る。 */
function connect(behave: Behave = (_call, send) => send()): void {
  vi.stubGlobal(
    "fetch",
    async (
      input: unknown,
      init?: { method?: string; body?: string; headers?: Record<string, string> },
    ) => {
      const path = String(input);
      const call: SentCall = {
        method: init?.method ?? "GET",
        path,
        body: init?.body === undefined ? null : (JSON.parse(init.body) as Record<string, unknown>),
      };
      calls.push(call);
      const send = async () =>
        await harness.app.request(
          `${ORIGIN}${path}`,
          {
            method: call.method,
            body: init?.body,
            headers: {
              ...init?.headers,
              // ブラウザが付けるもの / Access が付けるもの。
              Origin: ORIGIN,
              ...(jwt === null ? {} : { "Cf-Access-Jwt-Assertion": jwt }),
            },
          },
          harness.env,
        );
      return await behave(call, send);
    },
  );
}

/** 解決を自分で起こせる関門(「送信中」の画面を観察するため)。 */
function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

function screen() {
  const root = mount(h(App, null));
  return {
    root,
    text: () => textOf(root),
    /** 評価ボタン(Again / Hard / Good / Easy)。 */
    ratings: () => byTag(root, "button").filter((b) => RATING_LABELS.includes(textOf(b))),
    has: (text: string) => byTag(root, "button").some((b) => textOf(b).includes(text)),
  };
}

/** 復習タブを開き、最初の出題を取り終えるまで待つ。 */
async function openReview() {
  const s = screen();
  await click(buttonByText(s.root, "復習"));
  await flush();
  return s;
}

/** めくって評価する。 */
async function answer(s: ReturnType<typeof screen>, label: string) {
  await click(buttonByText(s.root, "めくる"));
  await click(buttonByText(s.root, label));
}

// --- 画面を通さない API 呼び出し(準備と確認用) ---

async function apiPost(path: string, body: unknown): Promise<Response> {
  return await harness.app.request(
    `${ORIGIN}${path}`,
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN,
        "Cf-Access-Jwt-Assertion": harness.jwt,
      },
    },
    harness.env,
  );
}

async function importCards(fronts: readonly string[]): Promise<Map<string, string>> {
  const res = await apiPost("/api/cards", {
    import_id: `import-${fronts.join("-")}`,
    cards: fronts.map((front) => ({ front, back: `${front} の意味` })),
  });
  expect(res.status).toBe(200);
  const ids = new Map<string, string>();
  for (const row of (await res.json<ImportResponse>()).results) {
    if (row.card_id) ids.set(row.front, row.card_id);
  }
  expect(ids.size).toBe(fronts.length);
  return ids;
}

async function importOne(front = "invoice"): Promise<string> {
  return (await importCards([front])).get(front) as string;
}

/** 画面の外(別の端末など)で 1 回評価する。 */
async function reviewElsewhere(cardId: string, version: number): Promise<void> {
  const res = await apiPost("/api/review", {
    review_id: `elsewhere-${cardId}-${version}`,
    card_id: cardId,
    rating: 3,
    expected_version: version,
    occurred_at: toUtcIso(new Date()),
    elapsed_ms: 1000,
  });
  expect(res.status).toBe(200);
}

async function serverDue(): Promise<DueResponse> {
  const res = await harness.app.request(
    `${ORIGIN}/api/due`,
    { headers: { "Cf-Access-Jwt-Assertion": harness.jwt } },
    harness.env,
  );
  expect(res.status).toBe(200);
  return await res.json<DueResponse>();
}

async function countReviews(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM reviews").first<{ n: number }>();
  return row?.n ?? 0;
}

async function stateOf(cardId: string) {
  return await env.DB.prepare("SELECT * FROM card_state WHERE card_id = ?")
    .bind(cardId)
    .first<Record<string, unknown>>();
}

function trace(): string[] {
  return calls.map((c) => `${c.method} ${c.path}`);
}

function reviewBodies(): Record<string, unknown>[] {
  return calls
    .filter((c) => c.path === "/api/review")
    .map((c) => c.body as Record<string, unknown>);
}

describe("復習画面(実 API)", () => {
  it("残り枚数 → 表 → めくる → 評価 の順に進む", async () => {
    connect();
    const cardId = await importOne();

    const s = await openReview();
    expect(s.text()).toContain("残り 1 枚");
    expect(s.text()).toContain("invoice");
    // めくる前に裏は見せない。評価もできない。
    expect(s.text()).not.toContain("invoice の意味");
    expect(s.ratings()).toHaveLength(0);

    await click(buttonByText(s.root, "めくる"));
    expect(s.text()).toContain("invoice の意味");
    expect(s.ratings().map((b) => textOf(b))).toEqual(RATING_LABELS);

    await click(buttonByText(s.root, "Good"));
    expect(trace()).toEqual(["GET /api/due", "POST /api/review"]);
    expect(await countReviews()).toBe(1);
    expect(await stateOf(cardId)).toMatchObject({ version: 2 });
    // 1 枚しか無かったので、次は短期カードの待ちになる。
    expect(s.text()).toContain("残り 1 枚");
    expect(s.text()).toContain("つぎのカードまで");
  });

  it("応答が消えても同じ review_id で再送し、二重評価にならない", async () => {
    let lost = 0;
    connect(async (call, send) => {
      const res = await send(); // 要求はサーバに届いている
      if (call.path === "/api/review" && lost < 2) {
        lost += 1;
        throw new TypeError("Network connection lost.");
      }
      return res;
    });
    const cardId = await importOne();

    const s = await openReview();
    await answer(s, "Good");
    expect(s.text()).toContain("通信できなかった");
    expect(s.text()).toContain("同じ評価をもう一度送れる");

    // 同じ評価を押し直しても、再送ボタンからでも、同じ review_id で同じ本文を送る。
    await click(buttonByText(s.root, "Good"));
    expect(s.text()).toContain("通信できなかった");
    await click(buttonByText(s.root, "同じ評価をもう一度送る"));

    const bodies = reviewBodies();
    expect(bodies).toHaveLength(3);
    expect(new Set(bodies.map((b) => b.review_id)).size).toBe(1);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[0]).toEqual(bodies[2]);

    // サーバには 1 回分だけ入り、画面も 1 回分だけ進む。
    expect(await countReviews()).toBe(1);
    expect(await stateOf(cardId)).toMatchObject({ version: 2 });
    expect(s.text()).not.toContain("通信できなかった");
    expect(s.text()).toContain("つぎのカードまで");
  });

  it("応答が消えたまま往復しても、同じ review_id で確定して短期カードが戻る", async () => {
    let lost = 0;
    connect(async (call, send) => {
      const res = await send(); // 要求はサーバに届いている
      if (call.path === "/api/review" && lost < 1) {
        lost += 1;
        throw new TypeError("Network connection lost.");
      }
      return res;
    });
    const cardId = await importOne();

    const s = await openReview();
    await answer(s, "Again"); // 届いているので 1 分後へ進んでいる
    expect(s.text()).toContain("通信できなかった");
    expect(await countReviews()).toBe(1);

    // タブを往復しても、送った 1 件は捨てない。サーバはこのカードをまだ出さない(期限は 1 分後)
    // ので、ここで手元から落とすと再送先も待ち時間も失う。
    await click(buttonByText(s.root, "単票追加"));
    await click(buttonByText(s.root, "復習"));
    await flush();
    expect((await serverDue()).cards).toEqual([]);
    expect(s.text()).toContain("残り 1 枚");
    expect(s.text()).toContain("通信できなかった");
    expect(s.has("同じ評価をもう一度送る")).toBe(true);

    // 同じ review_id で送り直すと、サーバは 1 回目の結果をそのまま返す(二重評価にならない)。
    await click(buttonByText(s.root, "同じ評価をもう一度送る"));
    const bodies = reviewBodies();
    expect(bodies).toHaveLength(2);
    expect(new Set(bodies.map((b) => b.review_id)).size).toBe(1);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(await countReviews()).toBe(1);
    expect(await stateOf(cardId)).toMatchObject({
      version: 2,
      due: toUtcIso(new Date(NOW.getTime() + MINUTE)),
    });

    // 確定した結果で待ち時間が戻り、時間が来たら同じ画面で出る。
    expect(s.text()).not.toContain("通信できなかった");
    expect(s.text()).toContain("つぎのカードまで あと 1 分 0 秒");
    vi.advanceTimersByTime(MINUTE);
    await flush();
    expect(s.text()).toContain("invoice");
    expect(s.has("めくる")).toBe(true);
  });

  it("送信中にタブを往復しても、取り直しが送信の結果を上書きしない", async () => {
    const held = gate();
    const refetch = gate();
    let gets = 0;
    connect(async (call, send) => {
      if (call.path === "/api/review") await held.wait;
      // 送信中に始まった 2 回目以降の取得は、送信より後に返す(古い応答で上書きされないか見る)。
      else if ((gets += 1) > 1) await refetch.wait;
      return await send();
    });
    const ids = await importCards(["invoice", "ledger"]);
    const order = (await serverDue()).cards.map((c) => c.front);
    const first = ids.get(order[0] as string) as string;

    const s = await openReview();
    await answer(s, "Good");
    expect(s.ratings().map((b) => b.disabled)).toEqual([true, true, true, true]);

    // 別のタブへ行って戻る(復習画面は作り直される)。送信中なので取り直しはしない。
    await click(buttonByText(s.root, "単票追加"));
    await click(buttonByText(s.root, "復習"));
    await flush();
    expect(trace()).toEqual(["GET /api/due", "POST /api/review"]);

    // 送信 → 取得 の順に応答を返す(取得が後から返っても送信後の状態を壊さない)。
    held.open();
    await flush();
    refetch.open();
    await flush();

    // 送信は終わっている。通信中でないのにボタンが無効のまま、にはならない。
    expect(await countReviews()).toBe(1);
    expect(await stateOf(first)).toMatchObject({ version: 2 });
    expect(s.text()).toContain(order[1] as string);
    await click(buttonByText(s.root, "めくる"));
    expect(s.ratings().map((b) => b.disabled)).toEqual([false, false, false, false]);

    // そのまま 2 枚目を評価できる。
    await click(buttonByText(s.root, "Good"));
    expect(await countReviews()).toBe(2);
  });

  it("別の評価に変えて送るときは新しい review_id で送る", async () => {
    connect(async (call, send) => {
      const res = await send();
      if (call.path === "/api/review" && reviewBodies().length === 1) {
        throw new TypeError("Network connection lost.");
      }
      return res;
    });
    await importOne();

    const s = await openReview();
    await answer(s, "Good");
    expect(s.text()).toContain("通信できなかった");

    // 評価を変えたら別の要求。1 回目の結果を返されては困るので review_id も変える。
    await click(buttonByText(s.root, "Again"));
    const bodies = reviewBodies();
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.review_id).not.toBe(bodies[1]?.review_id);
    expect(bodies[0]?.rating).toBe(3);
    expect(bodies[1]?.rating).toBe(1);
    // 1 回目は届いているので 409(手元の version が古い)→ 出し直して続ける。
    expect(trace()).toEqual([
      "GET /api/due",
      "POST /api/review",
      "POST /api/review",
      "GET /api/due",
    ]);
    expect(await countReviews()).toBe(1);
  });

  it("409 なら due を取り直して続ける", async () => {
    connect();
    const ids = await importCards(["invoice", "ledger"]);
    const order = (await serverDue()).cards.map((c) => c.front);
    const first = ids.get(order[0] as string) as string;

    const s = await openReview();
    expect(s.text()).toContain("残り 2 枚");

    // 画面が持っている version を、別の経路からの評価で古くする。
    await reviewElsewhere(first, 1);

    await answer(s, "Good");
    expect(trace()).toEqual(["GET /api/due", "POST /api/review", "GET /api/due"]);
    expect(s.text()).toContain("出し直した");
    expect(s.text()).toContain("version_conflict");
    // 競合したカードは学習ステップ待ちになっているので、残りは 2 枚目だけ。
    expect(s.text()).toContain("残り 1 枚");
    expect(s.text()).toContain(order[1] as string);
    expect(s.text()).not.toContain(order[0] as string);
    expect(await countReviews()).toBe(1);

    // 取り直した version で続けられる。
    await answer(s, "Good");
    expect(await countReviews()).toBe(2);
    expect(s.text()).not.toContain("出し直した");
  });

  it("認証切れ(401)は再ログインを案内し、再送しない", async () => {
    connect();
    const cardId = await importOne();
    const s = await openReview();

    jwt = null; // Access のセッションが切れた
    await answer(s, "Good");

    expect(s.text()).toContain("ログインの有効期限が切れた");
    // 出すのはログインし直す導線だけ。評価も再送も取り直しも押せない(= 再送ループにならない)。
    expect(byTag(s.root, "a").map((a) => a.getAttribute("href"))).toEqual(["/"]);
    expect(s.text()).toContain("再読み込みしてログインし直す");
    expect(s.ratings()).toHaveLength(0);
    expect(s.has("同じ評価をもう一度送る")).toBe(false);
    expect(s.has("取り直す")).toBe(false);

    // 401 を見た時点で止まる(取り直しも再送もしない)。
    expect(trace()).toEqual(["GET /api/due", "POST /api/review"]);

    // 時間が経っても、タブを往復しても、勝手に送り直さない。
    const sent = trace().length;
    vi.advanceTimersByTime(5 * MINUTE);
    await flush();
    await click(buttonByText(s.root, "単票追加"));
    await click(buttonByText(s.root, "復習"));
    expect(trace()).toHaveLength(sent);
    expect(s.text()).toContain("ログインの有効期限が切れた");

    expect(await countReviews()).toBe(0);
    expect(await stateOf(cardId)).toMatchObject({ version: 1 });
  });

  it("出題の取得に失敗したら理由を出し、取り直せる", async () => {
    let offline = true;
    connect(async (_call, send) => {
      if (offline) throw new TypeError("Failed to fetch");
      return await send();
    });
    await importOne();

    const s = await openReview();
    expect(s.text()).toContain("通信できなかった");
    expect(s.text()).not.toContain("invoice");

    offline = false;
    await click(buttonByText(s.root, "取り直す"));
    expect(s.text()).toContain("残り 1 枚");
    expect(s.text()).toContain("invoice");
    expect(s.text()).not.toContain("通信できなかった");
  });

  it("開いた時点で認証が切れていれば、取り直しもせずに再ログインを案内する", async () => {
    connect();
    await importOne();

    jwt = null;
    const s = await openReview();
    expect(s.text()).toContain("再読み込みしてログインし直す");
    expect(trace()).toEqual(["GET /api/due"]);

    vi.advanceTimersByTime(5 * MINUTE);
    await flush();
    expect(trace()).toEqual(["GET /api/due"]);
  });

  it("送信中は評価ボタンが無効で、押し直しても二重に送らない", async () => {
    const held = gate();
    connect(async (call, send) => {
      if (call.path === "/api/review") await held.wait;
      return await send();
    });
    const cardId = await importOne();

    const s = await openReview();
    await answer(s, "Good");

    expect(s.ratings().map((b) => b.disabled)).toEqual([true, true, true, true]);
    expect(s.text()).toContain("送信中は評価を受け付けない");
    for (const label of RATING_LABELS) await click(buttonByText(s.root, label));
    expect(reviewBodies()).toHaveLength(1);

    held.open();
    await flush();
    expect(reviewBodies()).toHaveLength(1);
    expect(await countReviews()).toBe(1);
    expect(await stateOf(cardId)).toMatchObject({ version: 2 });
  });
});

describe("復習画面(短期カード)", () => {
  it("学習ステップの待ち時間を出し、時間が来たら同じ画面で出し直す", async () => {
    connect();
    const cardId = await importOne();

    const s = await openReview();
    await answer(s, "Again"); // 1 分後へ
    expect(await stateOf(cardId)).toMatchObject({
      version: 2,
      due: toUtcIso(new Date(NOW.getTime() + MINUTE)),
    });

    // 手元に残して待ち時間を出す(サーバはまだ出さない)。
    expect(s.text()).toContain("残り 1 枚");
    expect(s.text()).toContain("つぎのカードまで あと 1 分 0 秒");
    expect(s.has("めくる")).toBe(false);
    expect((await serverDue()).cards).toEqual([]);

    vi.advanceTimersByTime(30 * 1000);
    await flush();
    expect(s.text()).toContain("つぎのカードまで あと 30 秒");
    expect(s.has("めくる")).toBe(false);

    // 1 分経ったら、取り直さずにそのまま出す。
    vi.advanceTimersByTime(30 * 1000);
    await flush();
    expect(s.text()).toContain("invoice");
    expect(s.has("めくる")).toBe(true);
    expect(trace()).toEqual(["GET /api/due", "POST /api/review"]);
    // サーバ側も同じ 1 枚を学習中として出すようになっている。
    expect((await serverDue()).cards.map((c) => [c.card_id, c.queue, c.version])).toEqual([
      [cardId, "learning", 2],
    ]);

    // 2 回目は取り直した version(2)で送る。
    await answer(s, "Good");
    expect(reviewBodies().at(-1)).toMatchObject({
      card_id: cardId,
      rating: 3,
      expected_version: 2,
      occurred_at: toUtcIso(new Date(NOW.getTime() + MINUTE)),
    });
    expect(await countReviews()).toBe(2);
    expect(await stateOf(cardId)).toMatchObject({ version: 3 });
  });

  it("長い間隔のカードは手元に残さない(次に取り直したときサーバが出す)", async () => {
    connect();
    const cardId = await importOne();

    // 学習ステップを抜けて復習(日単位)に入るまで評価する。
    const s = await openReview();
    await answer(s, "Easy"); // New + Easy は 1 日以上先の復習へ
    const state = await stateOf(cardId);
    expect(state).toMatchObject({ fsrs_state: 2 });
    expect(Date.parse(String(state?.due)) - NOW.getTime()).toBeGreaterThan(60 * MINUTE);

    expect(s.text()).toContain("残り 0 枚");
    expect(s.text()).toContain("いま出すカードは無い");
  });
});
