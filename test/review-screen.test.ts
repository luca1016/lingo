// 復習画面(src/client/Review.tsx + src/client/review.ts のストア)を実画面として描画し、
// 実 API(workerd + ローカル D1)に繋いで動かす。画面の fetch をそのまま Worker(Hono)へ渡し、
// ブラウザと Access の代わりに Origin と JWT を足す(差し替えるのは JWKS 取得関数だけ
// = test/access-harness.ts。検証経路は本番と同じ)。
//
// ここで押さえること(Issue 5 と設計の差し替え 4 回目):
//  - 残り枚数 → 表 → めくる → 評価 / 送信中は評価ボタンが無効
//  - 応答が消えたあとの再送で二重評価にならない(同じ review_id・同じ expected_version)
//  - 未確定の 1 件があるあいだは再送しかできない(別カードの評価・取得・タブ復帰での差し替えが無い)
//  - 409 は確定として扱い、最新を取り直して続ける
//  - 応答がいつまでも返らない送信は期限で未確定になり、同じ本文で再送できる(送信中のまま固まらない)
//  - 認証切れ(401)は再ログインを案内し、再送ループにしない
//  - 取得中は GET を重ねて出さない / 表示中は GET を出さない(表示中のカードが入れ替わらない)
//  - 短期カード(学習ステップ)は next_due_at で待ち時間を出し、時間が来たらサーバーから出し直す
//  - アンマウント → 再マウントで状態(表示中・送信中・未確定)が残る

import { env } from "cloudflare:workers";
import { h } from "preact";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/client/App";
import { resetSession } from "../src/client/review";
import { POST_TIMEOUT_MS } from "../src/client/review-api";
import type { ImportResponse } from "../src/shared/cards";
import type { DueResponse } from "../src/shared/review";
import { toUtcIso } from "../src/worker/time";
import { type AccessHarness, createAccessHarness, ORIGIN } from "./access-harness";
import { buttonByText, byTag, click, type FakeElement, flush, mount, textOf, unmount } from "./dom";

// 固定時計(JST では 2026-10-26 10:23)。Date と setInterval だけを偽物にする
//(flush() の setTimeout は本物のまま使いたい)。
const NOW = new Date("2026-10-26T01:23:45.000Z");
const MINUTE = 60 * 1000;

const RATING_LABELS = ["Again", "Hard", "Good", "Easy"];
const ALL_DISABLED = [true, true, true, true];
const ALL_ENABLED = [false, false, false, false];

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
  // ストアは画面の外にあるので、テストごとに初期状態へ戻す。
  resetSession();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM reviews"),
    env.DB.prepare("DELETE FROM card_state"),
    env.DB.prepare("DELETE FROM cards"),
    env.DB.prepare("DELETE FROM imports"),
  ]);
});

afterEach(() => {
  // 描いた画面は外す(残したままだとストアを購読し続け、次のテストの取得に割り込む)。
  for (const root of mounted) unmount(root);
  mounted = [];
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

/** 要求はサーバに届くが、応答だけが消える(先頭 `times` 回)。 */
function losePostResponse(times = 1): void {
  let lost = 0;
  connect(async (call, send) => {
    const res = await send(); // 要求はサーバに届いている
    if (call.path === "/api/review" && lost < times) {
      lost += 1;
      throw new TypeError("Network connection lost.");
    }
    return res;
  });
}

/** 解決を自分で起こせる関門(「送信中」や「取得中」の画面を観察するため)。 */
function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** 描いた画面の根(テストの終わりに外す)。 */
let mounted: FakeElement[] = [];

function screen() {
  const root = mount(h(App, null));
  mounted.push(root);
  return {
    root,
    text: () => textOf(root),
    /** 評価ボタン(Again / Hard / Good / Easy)。 */
    ratings: () => byTag(root, "button").filter((b) => RATING_LABELS.includes(textOf(b))),
    disabled: () =>
      byTag(root, "button")
        .filter((b) => RATING_LABELS.includes(textOf(b)))
        .map((b) => b.disabled),
    has: (text: string) => byTag(root, "button").some((b) => textOf(b).includes(text)),
  };
}

/** 復習タブを開く(最初の取得が終わるまで待つ)。 */
async function openReview() {
  const s = screen();
  await click(buttonByText(s.root, "復習"));
  await flush();
  return s;
}

/** 別のタブへ行って戻る(復習画面は作り直される = MOUNT)。 */
async function roundTrip(s: ReturnType<typeof screen>) {
  await click(buttonByText(s.root, "単票追加"));
  await click(buttonByText(s.root, "復習"));
  await flush();
}

/** 画面を外して作り直す(ストアに状態が残っているかを見る)。 */
async function remount(s: ReturnType<typeof screen>) {
  unmount(s.root);
  await flush();
  return await openReview();
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

/** サーバが出す順に front を並べる(A = 1 枚目、B = 2 枚目)。 */
async function twoCards(): Promise<{
  a: string;
  b: string;
  aId: string;
  bId: string;
}> {
  const ids = await importCards(["invoice", "ledger"]);
  const [a, b] = (await serverDue()).cards.map((c) => c.front) as [string, string];
  return { a, b, aId: ids.get(a) as string, bId: ids.get(b) as string };
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

describe("復習画面(基本)", () => {
  it("残り枚数 → 表 → めくる → 評価 の順に進み、確定したらサーバに訊き直す", async () => {
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
    expect(s.disabled()).toEqual(ALL_ENABLED);

    await click(buttonByText(s.root, "Good"));
    // 確定したら手元には何も残さず、次の 1 枚をサーバに訊く。
    expect(trace()).toEqual(["GET /api/due", "POST /api/review", "GET /api/due"]);
    expect(await countReviews()).toBe(1);
    expect(await stateOf(cardId)).toMatchObject({ version: 2 });
    // 1 枚しか無かったので、次は学習ステップ(10 分)の待ちになる。
    expect(s.text()).toContain("残り 0 枚");
    expect(s.text()).toContain("つぎのカードまで あと 10 分 0 秒");
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

    expect(s.disabled()).toEqual(ALL_DISABLED);
    expect(s.text()).toContain("送信中は評価を受け付けない");
    for (const label of RATING_LABELS) await click(buttonByText(s.root, label));
    expect(reviewBodies()).toHaveLength(1);

    held.open();
    await flush();
    expect(reviewBodies()).toHaveLength(1);
    expect(await countReviews()).toBe(1);
    expect(await stateOf(cardId)).toMatchObject({ version: 2 });
  });

  it("応答が消えても同じ review_id で再送し、二重評価にならない", async () => {
    losePostResponse(2);
    const cardId = await importOne();

    const s = await openReview();
    await answer(s, "Good");
    expect(s.text()).toContain("送信を確認できません");
    expect(s.text()).toContain("通信できなかった");

    // 未確定のあいだ、押せるのは再送だけ(評価ボタンは全部無効)。
    expect(s.disabled()).toEqual(ALL_DISABLED);
    await click(buttonByText(s.root, "再送"));
    expect(s.text()).toContain("送信を確認できません");
    await click(buttonByText(s.root, "再送"));

    // 3 回とも同じ本文(同じ review_id・同じ expected_version)。
    const bodies = reviewBodies();
    expect(bodies).toHaveLength(3);
    expect(new Set(bodies.map((b) => b.review_id)).size).toBe(1);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);

    // サーバには 1 回分だけ入り、画面も 1 回分だけ進む。
    expect(await countReviews()).toBe(1);
    expect(await stateOf(cardId)).toMatchObject({ version: 2 });
    expect(s.text()).not.toContain("送信を確認できません");
    expect(s.text()).toContain("つぎのカードまで");
  });

  it("409 は確定として扱い、最新を取り直して続ける", async () => {
    connect();
    const { a, b, aId, bId } = await twoCards();

    const s = await openReview();
    expect(s.text()).toContain("残り 2 枚");
    expect(s.text()).toContain(a);

    // 画面が持っている version を、別の経路からの評価で古くする。
    await reviewElsewhere(aId, 1);

    await answer(s, "Good");
    expect(trace()).toEqual(["GET /api/due", "POST /api/review", "GET /api/due"]);
    // 1 枚目は別版で弾かれ、取り直した結果(2 枚目)が出る。
    expect(await countReviews()).toBe(1);
    expect(s.text()).toContain("残り 1 枚");
    expect(s.text()).toContain(b);
    expect(s.text()).not.toContain(a);

    await answer(s, "Good");
    expect(reviewBodies().at(-1)).toMatchObject({ card_id: bId, expected_version: 1 });
    expect(await countReviews()).toBe(2);
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
    expect(s.has("再送")).toBe(false);
    expect(s.has("取り直す")).toBe(false);
    expect(trace()).toEqual(["GET /api/due", "POST /api/review"]);

    // 時間が経っても、タブを往復しても、勝手に送り直さない。
    vi.advanceTimersByTime(5 * MINUTE);
    await flush();
    await roundTrip(s);
    expect(trace()).toEqual(["GET /api/due", "POST /api/review"]);
    expect(s.text()).toContain("ログインの有効期限が切れた");

    expect(await countReviews()).toBe(0);
    expect(await stateOf(cardId)).toMatchObject({ version: 1 });
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
    await roundTrip(s);
    expect(trace()).toEqual(["GET /api/due"]);
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
    expect(s.text()).not.toContain("いま出すカードは無い");

    offline = false;
    await click(buttonByText(s.root, "取り直す"));
    expect(s.text()).toContain("残り 1 枚");
    expect(s.text()).toContain("invoice");
    expect(s.text()).not.toContain("通信できなかった");
  });
});

// 短期カード(学習ステップ)。待ち時間は応答の next_due_at で出し、時間が来たら訊き直す。
describe("復習画面(短期カード)", () => {
  it("学習ステップの待ち時間を出し、時間が来たらサーバーから出し直す", async () => {
    connect();
    const cardId = await importOne();

    const s = await openReview();
    await answer(s, "Again"); // 1 分後へ
    expect(await stateOf(cardId)).toMatchObject({
      version: 2,
      due: toUtcIso(new Date(NOW.getTime() + MINUTE)),
    });

    // 確定したので手元にカードは残らない。待ち時間はサーバが返した next_due_at。
    expect((await serverDue()).cards).toEqual([]);
    expect(s.text()).toContain("残り 0 枚");
    expect(s.text()).toContain("つぎのカードまで あと 1 分 0 秒");
    expect(s.has("めくる")).toBe(false);
    expect(trace()).toEqual(["GET /api/due", "POST /api/review", "GET /api/due"]);

    vi.advanceTimersByTime(30 * 1000);
    await flush();
    expect(s.text()).toContain("つぎのカードまで あと 30 秒");
    expect(s.has("めくる")).toBe(false);
    expect(trace()).toHaveLength(3); // 待っているあいだは訊きに行かない

    // 1 分経ったら訊き直し、サーバが学習中として出した 1 枚が並ぶ。
    vi.advanceTimersByTime(30 * 1000);
    await flush();
    expect(trace()).toEqual(["GET /api/due", "POST /api/review", "GET /api/due", "GET /api/due"]);
    expect(s.text()).toContain("invoice");
    expect(s.has("めくる")).toBe(true);

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

  it("学習ステップを抜けたカードは、待ち時間も残らない", async () => {
    connect();
    const cardId = await importOne();

    const s = await openReview();
    await answer(s, "Easy"); // New + Easy は 1 日以上先の復習へ
    const state = await stateOf(cardId);
    expect(state).toMatchObject({ fsrs_state: 2 });
    expect(Date.parse(String(state?.due)) - NOW.getTime()).toBeGreaterThan(60 * MINUTE);

    // next_due_at は返るが 1 日以上先。画面は「無い」とだけ出し、取り直せる。
    expect(s.text()).toContain("残り 0 枚");
    expect(s.text()).toContain("つぎのカードまで");
    expect(s.has("めくる")).toBe(false);
  });
});

// 設計の差し替え(4 回目)で決めた 6 本。
describe("復習画面(未確定の 1 件)", () => {
  it("1: 未確定のあいだ他の操作は無効で、再送で確定してから次へ進む", async () => {
    losePostResponse();
    const { a, b, aId, bId } = await twoCards();

    const s = await openReview();
    expect(s.text()).toContain("残り 2 枚");
    expect(s.text()).toContain(a);

    // A を Again(1 分)。届いたが応答が消えた → 結果は未確定。
    await answer(s, "Again");
    expect(s.text()).toContain("送信を確認できません");
    expect(await countReviews()).toBe(1);

    // タブを往復しても取得しない(= 表示中の A が B に差し替わらない)。
    await roundTrip(s);
    expect(trace()).toEqual(["GET /api/due", "POST /api/review"]);
    expect(s.text()).toContain(a);
    expect(s.text()).not.toContain(b);
    expect(s.text()).toContain("残り 2 枚");

    // B は評価できない。押せるのは A の再送だけ。
    expect(s.disabled()).toEqual(ALL_DISABLED);
    for (const label of RATING_LABELS) await click(buttonByText(s.root, label));
    expect(reviewBodies()).toHaveLength(1);
    expect(await countReviews()).toBe(1);
    expect(await stateOf(bId)).toMatchObject({ version: 1 });

    // 再送(同じ review_id・同じ expected_version)で 200。サーバは 1 回目の結果を返す。
    await click(buttonByText(s.root, "再送"));
    const bodies = reviewBodies();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[0]).toMatchObject({ card_id: aId, rating: 1, expected_version: 1 });
    expect(await countReviews()).toBe(1); // ログは 1 行だけ
    expect(await stateOf(aId)).toMatchObject({
      version: 2,
      due: toUtcIso(new Date(NOW.getTime() + MINUTE)),
    });

    // 確定したので訊き直し、B が出る(A は 1 分後までサーバが出さない)。
    expect(trace()).toEqual([
      "GET /api/due",
      "POST /api/review",
      "POST /api/review",
      "GET /api/due",
    ]);
    expect(s.text()).not.toContain("送信を確認できません");
    expect(s.text()).toContain("残り 1 枚");
    expect(s.text()).toContain(b);

    // B を評価すると出すものが無くなり、待ち時間は A の due になる。
    await answer(s, "Good");
    expect(await countReviews()).toBe(2);
    expect(s.text()).toContain("残り 0 枚");
    expect(s.text()).toContain("つぎのカードまで あと 1 分 0 秒");

    // 1 分後に A が戻り、確定した version で評価できる。
    vi.advanceTimersByTime(MINUTE);
    await flush();
    expect(s.text()).toContain(a);
    await answer(s, "Good");
    expect(reviewBodies().at(-1)).toMatchObject({ card_id: aId, expected_version: 2 });
    expect(await countReviews()).toBe(3);
  });

  it("2: 取得中は GET を重ねて出さず、遅れて返った 1 本をそのまま使う", async () => {
    // 取得の応答だけを関門で止める(要求はその時点の内容で処理される)。
    const gates = [gate(), gate()];
    let gets = 0;
    connect(async (call, send) => {
      if (call.path.startsWith("/api/due")) {
        const held = gates[gets];
        gets += 1;
        const res = await send();
        if (held) await held.wait;
        return res;
      }
      return await send();
    });
    const { a, b, aId } = await twoCards();

    // GET① を保留。タブを往復しても(MOUNT)、取得中なので GET は増えない。
    const s = await openReview();
    expect(s.text()).toContain("読み込み中");
    await roundTrip(s);
    expect(trace()).toEqual(["GET /api/due"]);
    vi.advanceTimersByTime(5 * MINUTE);
    await flush();
    expect(trace()).toEqual(["GET /api/due"]);

    // GET① が返ったら、その 1 本の結果で A を出す。
    gates[0]?.open();
    await flush();
    expect(s.text()).toContain(a);

    // 評価して 200 → 確定 → GET② を発行。これも保留中は重ねない。
    await answer(s, "Good");
    expect(trace()).toEqual(["GET /api/due", "POST /api/review", "GET /api/due"]);
    expect(await stateOf(aId)).toMatchObject({ version: 2 });
    await roundTrip(s);
    expect(trace()).toEqual(["GET /api/due", "POST /api/review", "GET /api/due"]);

    gates[1]?.open();
    await flush();
    expect(s.text()).toContain(b);
    expect(s.text()).not.toContain(a);
  });

  it("3: 表示中は取得しないので、サーバ側が進んでも表示は切り替わらない(409 で取り直す)", async () => {
    connect();
    const { a, b, aId, bId } = await twoCards();

    const s = await openReview();
    expect(s.text()).toContain(a);

    // 別の端末が A を評価した(サーバの GET はもう A を出さず B だけを返す)。
    await reviewElsewhere(aId, 1);
    expect((await serverDue()).cards.map((c) => c.front)).toEqual([b]);

    // タブ往復・時間の経過でも、表示中の A は B に入れ替わらない(GET も出さない)。
    await roundTrip(s);
    vi.advanceTimersByTime(2 * MINUTE);
    await flush();
    expect(trace()).toEqual(["GET /api/due"]);
    expect(s.text()).toContain(a);
    expect(s.text()).not.toContain(b);

    // 評価すると別版で 409。確定として扱い、取り直した B を出す。
    await answer(s, "Good");
    expect(trace()).toEqual(["GET /api/due", "POST /api/review", "GET /api/due"]);
    expect(s.text()).toContain(b);
    expect(s.text()).not.toContain(a);
    expect(await countReviews()).toBe(1);

    await answer(s, "Good");
    expect(reviewBodies().at(-1)).toMatchObject({ card_id: bId, expected_version: 1 });
    expect(await countReviews()).toBe(2);
  });

  it("4: 期限を過ぎてから再送が確定しても、短期カードは取りこぼさない", async () => {
    let lose = false;
    connect(async (call, send) => {
      const res = await send(); // 要求はサーバに届いている
      if (call.path === "/api/review" && lose) {
        lose = false;
        throw new TypeError("Network connection lost.");
      }
      return res;
    });
    const { a, b, aId, bId } = await twoCards();

    const s = await openReview();
    await answer(s, "Again"); // A は 1 分後へ
    expect(s.text()).toContain(b);

    // B の応答が消える。未確定のあいだは A の期限が来ても表示は変わらない。
    lose = true;
    await answer(s, "Good");
    expect(s.text()).toContain("送信を確認できません");
    vi.advanceTimersByTime(2 * MINUTE);
    await flush();
    expect(s.text()).toContain(b);
    expect(s.text()).not.toContain(a);
    expect(trace().filter((t) => t === "GET /api/due")).toHaveLength(2);

    // 再送で 200(冪等)。確定したら訊き直し、期限の来た A が出る。
    await click(buttonByText(s.root, "再送"));
    expect(reviewBodies()).toHaveLength(3);
    expect(reviewBodies()[2]).toEqual(reviewBodies()[1]);
    expect(await countReviews()).toBe(2);
    expect(await stateOf(bId)).toMatchObject({ version: 2 });
    expect(s.text()).toContain(a);
    expect(s.has("めくる")).toBe(true);

    await answer(s, "Good");
    expect(reviewBodies().at(-1)).toMatchObject({ card_id: aId, expected_version: 2 });
    expect(await countReviews()).toBe(3);
  });

  it("5: 200 と 409 だけが確定で、404・5xx・タイムアウト・JSON 不正・401 は確定させない", async () => {
    // 1 回目の POST だけ `fail` の中身を返す(2 回目の再送は実サーバへ通す)。
    let fail: (() => Promise<Response>) | null = null;
    connect(async (call, send) => {
      if (call.path === "/api/review" && fail) {
        const behave = fail;
        fail = null;
        return await behave();
      }
      return await send();
    });
    const cases: [string, () => Promise<Response>, string][] = [
      ["5xx", async () => new Response("boom", { status: 500 }), "失敗しました(500)"],
      [
        "通信の中断(即時の例外)",
        async () => {
          throw new TypeError("The operation timed out.");
        },
        "通信できなかった",
      ],
      ["JSON 不正", async () => new Response("<html>", { status: 200 }), "応答を読み取れなかった"],
    ];

    for (const [name, behave, message] of cases) {
      for (const root of mounted) unmount(root);
      mounted = [];
      resetSession();
      calls = [];
      await env.DB.batch([
        env.DB.prepare("DELETE FROM reviews"),
        env.DB.prepare("DELETE FROM card_state"),
        env.DB.prepare("DELETE FROM cards"),
        env.DB.prepare("DELETE FROM imports"),
      ]);
      const cardId = await importOne(name);

      fail = behave;
      const s = await openReview();
      await answer(s, "Good");
      expect(s.text(), name).toContain("送信を確認できません");
      expect(s.text(), name).toContain(message);
      expect(s.disabled(), name).toEqual(ALL_DISABLED);
      expect(trace(), name).toEqual(["GET /api/due", "POST /api/review"]);

      // 再送だけで確定する(勝手に次へ進まない)。
      await click(buttonByText(s.root, "再送"));
      expect(reviewBodies()[1], name).toEqual(reviewBodies()[0]);
      expect(await countReviews(), name).toBe(1);
      expect(await stateOf(cardId), name).toMatchObject({ version: 2 });
      expect(s.text(), name).not.toContain("送信を確認できません");
    }
  });

  it("5: 応答がいつまでも返らなければ、期限で未確定にして同じ本文で再送できる", async () => {
    // 要求はサーバに届くが、応答(と本文の読み取り)がいつまでも終わらない通信。
    const stuck = gate();
    let hold = true;
    connect(async (call, send) => {
      const res = await send(); // 要求はサーバに届いている
      if (call.path === "/api/review" && hold) {
        hold = false;
        await stuck.wait; // 応答は返ってこない
      }
      return res;
    });
    const cardId = await importOne();

    const s = await openReview();
    await answer(s, "Good");

    // 期限が来るまでは送信中(評価も再送もできない)。
    expect(s.text()).toContain("送信中は評価を受け付けない");
    expect(s.disabled()).toEqual(ALL_DISABLED);
    expect(s.has("再送")).toBe(false);

    // 期限を過ぎたら、結果の分からない 1 件として扱う(送信中のまま固まらない)。
    vi.advanceTimersByTime(POST_TIMEOUT_MS);
    await flush();
    expect(s.text()).toContain("送信を確認できません");
    expect(s.text()).toContain("応答を待てなかった");
    expect(s.disabled()).toEqual(ALL_DISABLED);

    // 同じ review_id・同じ expected_version で再送すると、サーバは 1 回目の結果を返す。
    await click(buttonByText(s.root, "再送"));
    const bodies = reviewBodies();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(await countReviews()).toBe(1);
    expect(await stateOf(cardId)).toMatchObject({ version: 2 });
    expect(s.text()).not.toContain("送信を確認できません");
    expect(s.text()).toContain("つぎのカードまで");

    // 捨てた 1 回目の応答が後から返っても、確定した結果は動かない。
    stuck.open();
    await flush();
    expect(reviewBodies()).toHaveLength(2);
    expect(await countReviews()).toBe(1);
    expect(s.text()).toContain("つぎのカードまで");
  });

  it("5: 404(カードが無い)でも確定させず、同じ attempt の再送に任せる", async () => {
    connect();
    const { a, b, aId, bId } = await twoCards();

    const s = await openReview();
    expect(s.text()).toContain(a);
    // 出している 1 枚を別の経路で論理削除する(POST /api/review は 404 になる)。
    await env.DB.prepare("UPDATE cards SET deleted_at = ? WHERE id = ?")
      .bind(toUtcIso(NOW), aId)
      .run();

    await answer(s, "Again");
    expect(s.text()).toContain("card_not_found");
    expect(s.text()).toContain(a);
    expect(s.text()).not.toContain(b);
    expect(s.disabled()).toEqual(ALL_DISABLED);

    await click(buttonByText(s.root, "再送"));
    expect(reviewBodies()[1]).toEqual(reviewBodies()[0]);
    expect(trace()).toEqual(["GET /api/due", "POST /api/review", "POST /api/review"]);
    expect(s.text()).toContain("card_not_found");
    expect(await countReviews()).toBe(0);
    expect(await stateOf(bId)).toMatchObject({ version: 1 });
  });

  it("6: アンマウント → 再マウントでも、表示中・送信中・未確定が残る", async () => {
    // (1) 表示中(めくった状態)
    connect();
    await importOne();
    let s = await openReview();
    await click(buttonByText(s.root, "めくる"));
    s = await remount(s);
    expect(s.text()).toContain("invoice の意味"); // めくったまま戻る
    expect(trace()).toEqual(["GET /api/due"]); // 取得も増えない
    expect(s.disabled()).toEqual(ALL_ENABLED);

    // (2) 送信中
    const held = gate();
    connect(async (call, send) => {
      if (call.path === "/api/review") await held.wait;
      return await send();
    });
    await click(buttonByText(s.root, "Good"));
    expect(s.disabled()).toEqual(ALL_DISABLED);
    s = await remount(s);
    expect(s.text()).toContain("送信中は評価を受け付けない");
    expect(s.disabled()).toEqual(ALL_DISABLED);
    expect(reviewBodies()).toHaveLength(1);
    // 画面を作り直しても、送信の結果はストアに入る。
    held.open();
    await flush();
    expect(await countReviews()).toBe(1);
    expect(s.text()).toContain("つぎのカードまで");

    // (3) 未確定
    vi.advanceTimersByTime(10 * MINUTE);
    await flush();
    losePostResponse();
    await answer(s, "Good");
    expect(s.text()).toContain("送信を確認できません");
    s = await remount(s);
    expect(s.text()).toContain("送信を確認できません");
    expect(s.has("再送")).toBe(true);
    expect(s.disabled()).toEqual(ALL_DISABLED);

    await click(buttonByText(s.root, "再送"));
    const bodies = reviewBodies();
    expect(bodies.at(-1)).toEqual(bodies.at(-2));
    expect(await countReviews()).toBe(2);
    expect(s.text()).not.toContain("送信を確認できません");
  });
});
