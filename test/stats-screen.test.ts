// 統計画面(src/client/Stats.tsx)を実画面として描画し、実 API(workerd + ローカル D1)に繋ぐ。
// 画面の fetch をそのまま Worker(Hono)へ渡し、ブラウザと Access の代わりに Origin と JWT を足す
//(差し替えるのは JWKS 取得関数だけ = test/access-harness.ts)。
//
// ここで押さえること(Issue 5):
//  - タブを開くと 4 つの数字(今 due / 今日中 due / 総数 / 連続日数)が出る
//  - 取得に失敗したら理由を出し、取り直せる
//  - 認証切れ(401)は再ログインを案内する
//  - タブを往復すると取り直す(サーバ側が変わっていれば新しい数字になる)

import { env } from "cloudflare:workers";
import { h } from "preact";
import { FSRSVersion, State } from "ts-fsrs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/client/App";
import type { ImportResponse } from "../src/shared/cards";
import { toUtcIso } from "../src/worker/time";
import { type AccessHarness, createAccessHarness, ORIGIN } from "./access-harness";
import { buttonByText, byTag, click, type FakeElement, flush, mount, textOf, unmount } from "./dom";

// 固定時計(JST では 2026-10-26 10:23)。当日の窓は UTC 10-25 15:00 〜 10-26 15:00。
const NOW = new Date("2026-10-26T01:23:45.000Z");
const NEXT_JST_DAY = new Date("2026-10-26T15:00:00.000Z");
const MINUTE = 60 * 1000;

let harness: AccessHarness;
/** 画面の送信に載せる Access JWT(null = セッションが切れた状態)。 */
let jwt: string | null = null;
/** 画面が送った要求の経路(順番どおり)。 */
let paths: string[] = [];
/** 描いた画面の根(テストの終わりに外す)。 */
let mounted: FakeElement[] = [];

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  harness = await createAccessHarness(NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(async () => {
  vi.setSystemTime(NOW);
  jwt = harness.jwt;
  paths = [];
  await env.DB.batch([
    env.DB.prepare("DELETE FROM reviews"),
    env.DB.prepare("DELETE FROM card_state"),
    env.DB.prepare("DELETE FROM cards"),
    env.DB.prepare("DELETE FROM imports"),
  ]);
});

afterEach(() => {
  for (const root of mounted) unmount(root);
  mounted = [];
  vi.unstubAllGlobals();
});

type Behave = (path: string, send: () => Promise<Response>) => Promise<Response>;

/** 画面の fetch を実 Worker に繋ぐ。`behave` で通信の失敗を作る。 */
function connect(behave: Behave = (_path, send) => send()): void {
  vi.stubGlobal(
    "fetch",
    async (
      input: unknown,
      init?: { method?: string; body?: string; headers?: Record<string, string> },
    ) => {
      const path = String(input);
      paths.push(path);
      const send = async () =>
        await harness.app.request(
          `${ORIGIN}${path}`,
          {
            method: init?.method ?? "GET",
            body: init?.body,
            headers: {
              ...init?.headers,
              Origin: ORIGIN,
              ...(jwt === null ? {} : { "Cf-Access-Jwt-Assertion": jwt }),
            },
          },
          harness.env,
        );
      return await behave(path, send);
    },
  );
}

function screen() {
  const root = mount(h(App, null));
  mounted.push(root);
  return {
    root,
    text: () => textOf(root),
    /** 画面に出ている「名前 → 数字」。 */
    metrics: () => {
      const values = byTag(root, "dd");
      const out: Record<string, string> = {};
      for (const [index, term] of byTag(root, "dt").entries()) {
        out[textOf(term)] = textOf(values[index] as FakeElement);
      }
      return out;
    },
    has: (text: string) => byTag(root, "button").some((b) => textOf(b).includes(text)),
  };
}

/** 統計タブを開く(最初の取得が終わるまで待つ)。 */
async function openStats() {
  const s = screen();
  await click(buttonByText(s.root, "統計"));
  await flush();
  return s;
}

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

async function setState(cardId: string, fsrsState: number, dueAt: Date) {
  await env.DB.prepare(
    "UPDATE card_state SET fsrs_state = ?, due = ?, updated_at = ? WHERE card_id = ?",
  )
    .bind(fsrsState, toUtcIso(dueAt), toUtcIso(NOW), cardId)
    .run();
}

async function reviewAt(cardId: string, reviewId: string, occurredAt: string) {
  await env.DB.prepare(
    `INSERT INTO reviews (review_id, card_id, rating, occurred_at, received_at, state_before,
       state_after, review_log, fsrs_version, params_version)
     VALUES (?, ?, 3, ?, ?, '{}', '{}', '{}', ?, 1)`,
  )
    .bind(reviewId, cardId, occurredAt, occurredAt, FSRSVersion)
    .run();
}

describe("統計画面", () => {
  it("4 つの数字(今 due / 今日中 due / 総数 / 連続日数)が出る", async () => {
    connect();
    const ids = await importCards(["past", "tonight", "later"]);
    // 期限切れ 1 枚 / 今日のうちに来る 1 枚 / 明後日 1 枚。
    await setState(ids.get("past") as string, State.Review, new Date(NOW.getTime() - MINUTE));
    await setState(
      ids.get("tonight") as string,
      State.Review,
      new Date(NEXT_JST_DAY.getTime() - MINUTE),
    );
    await setState(
      ids.get("later") as string,
      State.Review,
      new Date(NEXT_JST_DAY.getTime() + 2 * 24 * 60 * MINUTE),
    );
    // 今日と前日に評価している(連続 2 日)。
    await reviewAt(ids.get("past") as string, "seed-today", "2026-10-26T01:00:00.000Z");
    await reviewAt(ids.get("past") as string, "seed-yesterday", "2026-10-25T01:00:00.000Z");

    const s = await openStats();
    expect(paths).toEqual(["/api/stats"]);
    expect(s.metrics()).toEqual({
      "今 due": "1",
      "今日中 due": "2",
      総数: "3",
      連続日数: "2",
    });
  });

  it("カードが無ければ 0 が 4 つ並ぶ", async () => {
    connect();
    const s = await openStats();
    expect(s.metrics()).toEqual({
      "今 due": "0",
      "今日中 due": "0",
      総数: "0",
      連続日数: "0",
    });
  });

  it("取得に失敗したら理由を出し、取り直せる", async () => {
    let calls = 0;
    connect(async (_path, send) => {
      calls += 1;
      if (calls === 1) throw new TypeError("Network connection lost.");
      return await send();
    });
    await importCards(["invoice"]);

    const s = await openStats();
    expect(s.text()).toContain("通信できなかった");
    expect(s.metrics()).toEqual({});

    await click(buttonByText(s.root, "取り直す"));
    await flush();
    expect(s.metrics()).toMatchObject({ 総数: "1" });
    expect(paths).toEqual(["/api/stats", "/api/stats"]);
  });

  it("認証切れ(401)は再ログインを案内し、取り直しは出さない", async () => {
    connect();
    jwt = null;

    const s = await openStats();
    expect(s.text()).toContain("ログインの有効期限が切れた");
    expect(s.text()).toContain("再読み込みしてログインし直す");
    expect(s.has("取り直す")).toBe(false);
  });

  it("タブを往復すると取り直す(サーバ側が変わっていれば新しい数字になる)", async () => {
    connect();
    const ids = await importCards(["invoice"]);
    const s = await openStats();
    expect(s.metrics()).toMatchObject({ 総数: "1", "今 due": "0" });

    // 別の端末で 1 枚増え、期限も来ている状態にする。
    const added = await importCards(["ledger"]);
    await setState(added.get("ledger") as string, State.Review, new Date(NOW.getTime() - MINUTE));
    await reviewAt(ids.get("invoice") as string, "seed-today", "2026-10-26T01:00:00.000Z");

    await click(buttonByText(s.root, "単票追加"));
    await click(buttonByText(s.root, "統計"));
    await flush();
    expect(s.metrics()).toEqual({
      "今 due": "1",
      "今日中 due": "1",
      総数: "2",
      連続日数: "1",
    });
  });
});
