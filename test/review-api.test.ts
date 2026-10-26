import { env } from "cloudflare:workers";
import { FSRSVersion, State } from "ts-fsrs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportResponse } from "../src/shared/cards";
import {
  DEFAULT_DUE_LIMIT,
  type DueResponse,
  MAX_DUE_LIMIT,
  type ReviewErrorResponse,
  type ReviewResponse,
} from "../src/shared/review";
import { DEFAULT_DECK_ID, type ReviewRow } from "../src/worker/db";
import { toUtcIso } from "../src/worker/time";
import { type AccessHarness, createAccessHarness, ORIGIN } from "./access-harness";

// 固定時計。NOW は JST では 2026-10-26 10:23(当日の窓は UTC 10-25 15:00 〜 10-26 15:00)。
const NOW = new Date("2026-10-26T01:23:45.000Z");
/** JST の 0 時(= UTC 15:00)。ここを跨ぐと「今日」が変わる。 */
const NEXT_JST_DAY = new Date("2026-10-26T15:00:00.000Z");
const MINUTE = 60 * 1000;

let harness: AccessHarness;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  harness = await createAccessHarness(NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

// D1 はテスト間で共有されるので、書き込む表は毎回空にする(migration が入れた行は消さない)。
beforeEach(async () => {
  vi.setSystemTime(NOW);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM reviews"),
    env.DB.prepare("DELETE FROM card_state"),
    env.DB.prepare("DELETE FROM cards"),
    env.DB.prepare("DELETE FROM imports"),
  ]);
});

async function post(path: string, body: unknown, h: AccessHarness = harness): Promise<Response> {
  return await h.app.request(
    `${ORIGIN}${path}`,
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN,
        "Cf-Access-Jwt-Assertion": h.jwt,
      },
    },
    h.env,
  );
}

async function get(path: string, h: AccessHarness = harness): Promise<Response> {
  return await h.app.request(
    `${ORIGIN}${path}`,
    { headers: { "Cf-Access-Jwt-Assertion": h.jwt } },
    h.env,
  );
}

async function due(query = "", h: AccessHarness = harness): Promise<DueResponse> {
  const res = await get(`/api/due${query}`, h);
  expect(res.status).toBe(200);
  return await res.json<DueResponse>();
}

let reviewSeq = 0;

/** 1 回の評価を送る。review_id は明示しなければ毎回新しくする。 */
function sendReview(params: {
  cardId: string;
  version: number;
  rating?: 1 | 2 | 3 | 4;
  reviewId?: string;
  occurredAt?: Date;
  elapsedMs?: number | null;
  h?: AccessHarness;
}): Promise<Response> {
  reviewSeq += 1;
  return post(
    "/api/review",
    {
      review_id: params.reviewId ?? `review-${String(reviewSeq).padStart(4, "0")}`,
      card_id: params.cardId,
      rating: params.rating ?? 3,
      expected_version: params.version,
      occurred_at: toUtcIso(params.occurredAt ?? new Date()),
      elapsed_ms: params.elapsedMs === undefined ? 4200 : params.elapsedMs,
    },
    params.h ?? harness,
  );
}

/** 取り込み経路(POST /api/cards)でカードを作り、front -> card_id を返す。 */
async function importCards(fronts: readonly string[]): Promise<Map<string, string>> {
  const res = await post("/api/cards", {
    import_id: `import-${fronts.length}-${fronts[0]}`,
    cards: fronts.map((front) => ({ front, back: `${front} の意味` })),
  });
  expect(res.status).toBe(200);
  const body = await res.json<ImportResponse>();
  const ids = new Map<string, string>();
  for (const row of body.results) if (row.card_id) ids.set(row.front, row.card_id);
  expect(ids.size).toBe(fronts.length);
  return ids;
}

async function importOne(front = "invoice"): Promise<string> {
  const ids = await importCards([front]);
  return ids.get(front) as string;
}

async function stateOf(cardId: string) {
  return await env.DB.prepare("SELECT * FROM card_state WHERE card_id = ?")
    .bind(cardId)
    .first<Record<string, unknown>>();
}

async function countReviews(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM reviews").first<{ n: number }>();
  return row?.n ?? 0;
}

/** card_state を直接書く(並び順のテスト用に状態を作り分ける)。 */
async function setState(cardId: string, fsrsState: number, dueAt: Date, version = 1) {
  await env.DB.prepare(
    "UPDATE card_state SET fsrs_state = ?, due = ?, version = ?, updated_at = ? WHERE card_id = ?",
  )
    .bind(fsrsState, toUtcIso(dueAt), version, toUtcIso(NOW), cardId)
    .run();
}

describe("POST /api/review(冪等)", () => {
  it("同じ review_id を 2 回送ると 2 回目も同じ応答で、state は 1 回分だけ進む", async () => {
    const cardId = await importOne();
    const first = await sendReview({ cardId, version: 1, reviewId: "same-review-id" });
    expect(first.status).toBe(200);
    const body = await first.json<ReviewResponse>();
    expect(body).toMatchObject({
      review_id: "same-review-id",
      card_id: cardId,
      rating: 3,
      occurred_at: toUtcIso(NOW),
    });
    expect(body.state.version).toBe(2);
    expect(body.state.fsrs_state).toBe(State.Learning);
    expect(body.state.reps).toBe(1);

    // 時間が経ってから同じ id で再送しても、1 回目とまったく同じ本文。
    vi.setSystemTime(new Date(NOW.getTime() + 5 * MINUTE));
    const again = await sendReview({
      cardId,
      version: 1,
      reviewId: "same-review-id",
      occurredAt: new Date(),
    });
    expect(again.status).toBe(200);
    expect(await again.json<ReviewResponse>()).toEqual(body);

    expect(await countReviews()).toBe(1);
    expect(await stateOf(cardId)).toMatchObject({ version: 2, due: body.state.due });
  });

  it("同じ review_id を 2 本同時に送っても、両方 200 で同じ応答(409 にしない)", async () => {
    const cardId = await importOne();
    const body = {
      review_id: "concurrent-resend",
      card_id: cardId,
      rating: 3,
      expected_version: 1,
      occurred_at: toUtcIso(NOW),
      elapsed_ms: 4200,
    };

    // 端末の再送が行き違って 2 本とも届いた状況。どちらも 1 回目の結果を返す。
    const [a, b] = await Promise.all([post("/api/review", body), post("/api/review", body)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const bodyA = await a.json<ReviewResponse>();
    expect(await b.json<ReviewResponse>()).toEqual(bodyA);
    expect(bodyA.state.version).toBe(2);

    expect(await countReviews()).toBe(1);
    expect(await stateOf(cardId)).toMatchObject({ version: 2, due: bodyA.state.due });
  });

  it("同じ review_id で中身が違えば(別の rating / expected_version)409", async () => {
    const cardId = await importOne();
    const first = await sendReview({ cardId, version: 1, reviewId: "r1", rating: 3 });
    expect(first.status).toBe(200);
    const after = await stateOf(cardId);

    // 冪等キーは「同じ要求の再送」のためのもの。中身が違うものは別の要求なので受け取らない。
    for (const body of [
      { rating: 1, expected_version: 1 },
      { rating: 3, expected_version: 2 },
      { rating: 3, expected_version: 99 },
    ]) {
      const res = await post("/api/review", {
        review_id: "r1",
        card_id: cardId,
        occurred_at: toUtcIso(NOW),
        ...body,
      });
      expect(res.status, JSON.stringify(body)).toBe(409);
      expect((await res.json<ReviewErrorResponse>()).error).toBe("version_conflict");
    }

    expect(await countReviews()).toBe(1);
    expect(await stateOf(cardId)).toEqual(after);
  });

  it("保存する行に state_before / state_after / review_log / 版と received_at が入る", async () => {
    const cardId = await importOne();
    const occurredAt = new Date(NOW.getTime() - 2 * MINUTE);
    // 受け取りは解答より後(受信時刻はサーバの時計で入る)。
    const res = await sendReview({ cardId, version: 1, rating: 2, occurredAt, elapsedMs: 1234 });
    expect(res.status).toBe(200);

    const row = await env.DB.prepare("SELECT * FROM reviews WHERE card_id = ?")
      .bind(cardId)
      .first<ReviewRow>();
    expect(row?.rating).toBe(2);
    expect(row?.occurred_at).toBe(toUtcIso(occurredAt));
    expect(row?.received_at).toBe(toUtcIso(NOW));
    expect(row?.elapsed_ms).toBe(1234);
    expect(row?.fsrs_version).toBe(FSRSVersion);
    expect(row?.params_version).toBe(1);
    expect(row?.correction_of).toBeNull();

    const before = JSON.parse(row?.state_before ?? "null");
    const after = JSON.parse(row?.state_after ?? "null");
    expect(before).toMatchObject({ card_id: cardId, version: 1, fsrs_state: State.New, reps: 0 });
    expect(after).toMatchObject({ card_id: cardId, version: 2, reps: 1 });
    expect(after).toEqual(await stateOf(cardId));
    // ts-fsrs の ReviewLog をそのまま入れる(加工しない)。
    expect(JSON.parse(row?.review_log ?? "null")).toMatchObject({
      rating: 2,
      state: State.New,
      review: toUtcIso(occurredAt),
    });

    expect((await res.json<ReviewResponse>()).state.last_review).toBe(toUtcIso(occurredAt));
  });

  it("elapsed_ms は省略できる(NULL で入る)", async () => {
    const cardId = await importOne();
    expect((await sendReview({ cardId, version: 1, elapsedMs: null })).status).toBe(200);
    const row = await env.DB.prepare("SELECT elapsed_ms FROM reviews").first<{
      elapsed_ms: number | null;
    }>();
    expect(row?.elapsed_ms).toBeNull();
  });
});

describe("POST /api/review(競合)", () => {
  it("古い expected_version は 409 で、state も reviews も変わらない", async () => {
    const cardId = await importOne();
    expect((await sendReview({ cardId, version: 1 })).status).toBe(200);
    const after = await stateOf(cardId);

    const stale = await sendReview({ cardId, version: 1 });
    expect(stale.status).toBe(409);
    const body = await stale.json<ReviewErrorResponse>();
    expect(body.error).toBe("version_conflict");
    expect(body.state?.version).toBe(2);
    expect(body.message).not.toBe("");

    expect(await stateOf(cardId)).toEqual(after);
    expect(await countReviews()).toBe(1);
  });

  it("新しすぎる expected_version も 409", async () => {
    const cardId = await importOne();
    const res = await sendReview({ cardId, version: 2 });
    expect(res.status).toBe(409);
    expect((await res.json<ReviewErrorResponse>()).state?.version).toBe(1);
    expect(await countReviews()).toBe(0);
    expect(await stateOf(cardId)).toMatchObject({ version: 1, fsrs_state: State.New });
  });

  it("同じ version で同時に 2 つ送ると片方だけ成功し、もう片方が 409", async () => {
    const cardId = await importOne();
    const [a, b] = await Promise.all([
      sendReview({ cardId, version: 1, reviewId: "race-a", rating: 3 }),
      sendReview({ cardId, version: 1, reviewId: "race-b", rating: 1 }),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const ok = a.status === 200 ? a : b;
    const conflicted = a.status === 200 ? b : a;
    const okBody = await ok.json<ReviewResponse>();
    expect(okBody.state.version).toBe(2);
    expect((await conflicted.json<ReviewErrorResponse>()).error).toBe("version_conflict");

    // 勝ったほうの 1 行だけが残り、state も 1 回分しか進んでいない。
    expect(await countReviews()).toBe(1);
    const row = await env.DB.prepare("SELECT review_id FROM reviews").first<{
      review_id: string;
    }>();
    expect(row?.review_id).toBe(okBody.review_id);
    expect(await stateOf(cardId)).toMatchObject({ version: 2, due: okBody.state.due });
  });
});

describe("POST /api/review(冪等キーの使い回し)", () => {
  it("同じ review_id を別のカードで送ったら 409 で、2 枚目は何も変わらない", async () => {
    const ids = await importCards(["invoice", "ledger"]);
    const first = ids.get("invoice") as string;
    const other = ids.get("ledger") as string;
    expect((await sendReview({ cardId: first, version: 1, reviewId: "shared-id" })).status).toBe(
      200,
    );

    // version は合っているので batch まで進むが、冪等キーが別のカードに使われているので 0 件になる。
    const res = await sendReview({ cardId: other, version: 1, reviewId: "shared-id" });
    expect(res.status).toBe(409);
    expect((await res.json<ReviewErrorResponse>()).error).toBe("version_conflict");

    expect(await countReviews()).toBe(1);
    expect(
      (await env.DB.prepare("SELECT card_id FROM reviews").first<{ card_id: string }>())?.card_id,
    ).toBe(first);
    expect(await stateOf(other)).toMatchObject({ version: 1, fsrs_state: State.New, reps: 0 });
    expect(await stateOf(first)).toMatchObject({ version: 2 });
  });

  it("同じ review_id を 2 枚のカードへ同時に送っても、進むのは片方だけ", async () => {
    const ids = await importCards(["invoice", "ledger"]);
    const one = ids.get("invoice") as string;
    const other = ids.get("ledger") as string;

    const [a, b] = await Promise.all([
      sendReview({ cardId: one, version: 1, reviewId: "shared-id" }),
      sendReview({ cardId: other, version: 1, reviewId: "shared-id" }),
    ]);

    // 片方は確定し、もう片方は「同じ要求の再送」ではないので 409。
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const ok = a.status === 200 ? a : b;
    const conflicted = a.status === 200 ? b : a;
    const okBody = await ok.json<ReviewResponse>();
    expect((await conflicted.json<ReviewErrorResponse>()).error).toBe("version_conflict");

    // ログは 1 行だけ。応答に入っているカードだけが 1 回分進み、もう片方は新規のまま。
    expect(await countReviews()).toBe(1);
    const untouched = okBody.card_id === one ? other : one;
    expect(await stateOf(okBody.card_id)).toMatchObject({ version: 2 });
    expect(await stateOf(untouched)).toMatchObject({ version: 1, fsrs_state: State.New, reps: 0 });
  });
});

describe("POST /api/review(入力の検証とガード)", () => {
  it("無いカード・論理削除したカードは 404", async () => {
    const missing = await sendReview({ cardId: "no-such-card", version: 1 });
    expect(missing.status).toBe(404);
    expect((await missing.json<ReviewErrorResponse>()).error).toBe("card_not_found");

    const cardId = await importOne();
    await env.DB.prepare("UPDATE cards SET deleted_at = ? WHERE id = ?")
      .bind(toUtcIso(NOW), cardId)
      .run();
    expect((await sendReview({ cardId, version: 1 })).status).toBe(404);
    expect(await countReviews()).toBe(0);
  });

  it("本文が壊れていれば 400 で、何も変わらない", async () => {
    const cardId = await importOne();
    const bad: [unknown, string][] = [
      [{}, "invalid_review_id"],
      [
        {
          review_id: "x",
          card_id: cardId,
          rating: 0,
          expected_version: 1,
          occurred_at: toUtcIso(NOW),
        },
        "invalid_rating",
      ],
      [
        {
          review_id: "x",
          card_id: cardId,
          rating: 3,
          expected_version: -1,
          occurred_at: toUtcIso(NOW),
        },
        "invalid_expected_version",
      ],
      [
        { review_id: "x", card_id: cardId, rating: 3, expected_version: 1, occurred_at: "きのう" },
        "invalid_occurred_at",
      ],
    ];
    for (const [body, code] of bad) {
      const res = await post("/api/review", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json<ReviewErrorResponse>()).error, JSON.stringify(body)).toBe(code);
    }

    const broken = await harness.app.request(
      `${ORIGIN}/api/review`,
      {
        method: "POST",
        body: "{",
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
          "Cf-Access-Jwt-Assertion": harness.jwt,
        },
      },
      harness.env,
    );
    expect(broken.status).toBe(400);
    expect((await broken.json<ReviewErrorResponse>()).error).toBe("invalid_json");

    expect(await countReviews()).toBe(0);
    expect(await stateOf(cardId)).toMatchObject({ version: 1 });
  });

  it("Access JWT が無い / 別 Origin / JSON でないなら書かない", async () => {
    const cardId = await importOne();
    const body = {
      review_id: "guarded",
      card_id: cardId,
      rating: 3,
      expected_version: 1,
      occurred_at: toUtcIso(NOW),
    };

    const noJwt = await harness.app.request(
      `${ORIGIN}/api/review`,
      {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
      },
      harness.env,
    );
    expect(noJwt.status).toBe(403);

    const crossOrigin = await harness.app.request(
      `${ORIGIN}/api/review`,
      {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example.com",
          "Cf-Access-Jwt-Assertion": harness.jwt,
        },
      },
      harness.env,
    );
    expect(crossOrigin.status).toBe(403);

    const notJson = await harness.app.request(
      `${ORIGIN}/api/review`,
      {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          "Content-Type": "text/plain",
          Origin: ORIGIN,
          "Cf-Access-Jwt-Assertion": harness.jwt,
        },
      },
      harness.env,
    );
    expect(notJson.status).toBe(415);

    expect(await countReviews()).toBe(0);
  });

  it("GET /api/due も Access JWT が無ければ 403", async () => {
    const res = await harness.app.request(`${ORIGIN}/api/due`, {}, harness.env);
    expect(res.status).toBe(403);
  });
});

describe("GET /api/due(並び順)", () => {
  it("学習中 → 復習 → 新規の順で、期限が来ていないものは出ない", async () => {
    const ids = await importCards([
      "learning-late",
      "learning-early",
      "learning-future",
      "review-due",
      "review-future",
      "fresh",
    ]);
    await setState(
      ids.get("learning-late") as string,
      State.Learning,
      new Date(NOW.getTime() - MINUTE),
    );
    await setState(
      ids.get("learning-early") as string,
      State.Relearning,
      new Date(NOW.getTime() - 2 * MINUTE),
    );
    await setState(
      ids.get("learning-future") as string,
      State.Learning,
      new Date(NOW.getTime() + 1),
    );
    await setState(ids.get("review-due") as string, State.Review, NOW);
    await setState(
      ids.get("review-future") as string,
      State.Review,
      new Date(NOW.getTime() + MINUTE),
    );

    const body = await due();
    expect(body.now).toBe(toUtcIso(NOW));
    expect(body.limit).toBe(DEFAULT_DUE_LIMIT);
    expect(body.cards.map((c) => c.front)).toEqual([
      "learning-early",
      "learning-late",
      "review-due",
      "fresh",
    ]);
    expect(body.cards.map((c) => c.queue)).toEqual(["learning", "learning", "review", "new"]);
  });

  it("各カードに version と中身が入る(そのまま評価を送れる)", async () => {
    const cardId = await importOne();
    const body = await due();
    expect(body.cards).toHaveLength(1);
    expect(body.cards[0]).toMatchObject({
      card_id: cardId,
      front: "invoice",
      back: "invoice の意味",
      example: null,
      note: null,
      version: 1,
      fsrs_state: State.New,
      queue: "new",
      reps: 0,
      lapses: 0,
    });

    // 返ってきた version をそのまま expected_version に使える。
    const res = await sendReview({
      cardId,
      version: body.cards[0]?.version as number,
    });
    expect(res.status).toBe(200);
  });

  it("limit の枚数までしか返さず、学習中を優先する", async () => {
    const ids = await importCards(["a", "b", "c"]);
    await setState(ids.get("a") as string, State.Learning, new Date(NOW.getTime() - MINUTE));
    await setState(ids.get("b") as string, State.Review, new Date(NOW.getTime() - MINUTE));

    expect((await due("?limit=1")).cards.map((c) => c.front)).toEqual(["a"]);
    expect((await due("?limit=2")).cards.map((c) => c.front)).toEqual(["a", "b"]);
    expect((await due("?limit=3")).cards.map((c) => c.front)).toEqual(["a", "b", "c"]);
  });

  it("limit が整数でない・範囲外なら 400", async () => {
    for (const value of ["0", "-1", "abc", "1.5", String(MAX_DUE_LIMIT + 1)]) {
      const res = await get(`/api/due?limit=${value}`);
      expect(res.status, value).toBe(400);
      expect((await res.json<ReviewErrorResponse>()).error, value).toBe("invalid_limit");
    }
  });

  it("論理削除したカードは出ない", async () => {
    const cardId = await importOne();
    await env.DB.prepare("UPDATE cards SET deleted_at = ? WHERE id = ?")
      .bind(toUtcIso(NOW), cardId)
      .run();
    expect((await due()).cards).toEqual([]);
  });
});

describe("GET /api/due(短期再出題)", () => {
  it("Again の直後は出ず、学習ステップ(1 分)が過ぎると学習中として出る", async () => {
    const cardId = await importOne();
    const res = await sendReview({ cardId, version: 1, rating: 1 });
    expect(res.status).toBe(200);
    const body = await res.json<ReviewResponse>();
    expect(body.state.fsrs_state).toBe(State.Learning);
    expect(Date.parse(body.state.due) - NOW.getTime()).toBe(MINUTE);

    // まだ 1 分経っていないので出題されない。
    expect((await due()).cards).toEqual([]);
    vi.setSystemTime(new Date(NOW.getTime() + MINUTE - 1));
    expect((await due()).cards).toEqual([]);

    // 1 分後に学習中として戻ってくる(version は 2 に進んでいる)。
    vi.setSystemTime(new Date(NOW.getTime() + MINUTE));
    const after = await due();
    expect(after.cards.map((c) => [c.card_id, c.queue, c.version])).toEqual([
      [cardId, "learning", 2],
    ]);

    // 2 回目の Again も同じように 1 分後へ送られる。
    const second = await sendReview({ cardId, version: 2, rating: 1, occurredAt: new Date() });
    expect(second.status).toBe(200);
    expect((await due()).cards).toEqual([]);
    vi.setSystemTime(new Date(NOW.getTime() + 2 * MINUTE));
    expect((await due()).cards.map((c) => c.version)).toEqual([3]);
  });

  it("Good は 10 分後(学習ステップの 2 段目)に戻ってくる", async () => {
    const cardId = await importOne();
    await sendReview({ cardId, version: 1, rating: 3 });

    vi.setSystemTime(new Date(NOW.getTime() + 9 * MINUTE));
    expect((await due()).cards).toEqual([]);
    vi.setSystemTime(new Date(NOW.getTime() + 10 * MINUTE));
    expect((await due()).cards.map((c) => c.queue)).toEqual(["learning"]);
  });
});

describe("GET /api/due(新規上限)", () => {
  /** 新規カードを n 枚初回評価する。 */
  async function startNew(ids: Map<string, string>, fronts: readonly string[]) {
    for (const front of fronts) {
      const res = await sendReview({ cardId: ids.get(front) as string, version: 1 });
      expect(res.status, front).toBe(200);
    }
  }

  it("当日 10 枚の初回評価で新規は出なくなり、JST 0 時を跨ぐと再び出る", async () => {
    const fronts = Array.from({ length: 12 }, (_, i) => `w${String(i).padStart(2, "0")}`);
    const ids = await importCards(fronts);

    const before = await due("?limit=100");
    expect(before.new_today).toBe(0);
    expect(before.new_remaining).toBe(10);
    // 上限を超えて新規は出さない(12 枚あっても 10 枚)。
    expect(before.cards).toHaveLength(10);
    expect(before.cards.every((c) => c.queue === "new")).toBe(true);

    await startNew(ids, fronts.slice(0, 9));
    const nearly = await due("?limit=100");
    expect(nearly.new_today).toBe(9);
    expect(nearly.new_remaining).toBe(1);
    expect(nearly.cards.filter((c) => c.queue === "new")).toHaveLength(1);

    await startNew(ids, fronts.slice(9, 10));
    const full = await due("?limit=100");
    expect(full.new_today).toBe(10);
    expect(full.new_remaining).toBe(0);
    expect(full.cards.filter((c) => c.queue === "new")).toEqual([]);

    // 同じカードを 2 回目に評価しても枠は増減しない(ユニーク枚数で数える)。
    const again = await sendReview({
      cardId: ids.get(fronts[0] as string) as string,
      version: 2,
      occurredAt: new Date(),
    });
    expect(again.status).toBe(200);
    expect((await due("?limit=100")).new_today).toBe(10);

    // JST 0 時(UTC 15:00)を跨ぐと「今日」が変わり、また新規が出る。
    vi.setSystemTime(NEXT_JST_DAY);
    const nextDay = await createAccessHarness(NEXT_JST_DAY);
    const tomorrow = await due("?limit=100", nextDay);
    expect(tomorrow.new_today).toBe(0);
    expect(tomorrow.new_remaining).toBe(10);
    expect(
      tomorrow.cards
        .filter((c) => c.queue === "new")
        .map((c) => c.front)
        .sort(),
    ).toEqual([fronts[10], fronts[11]]);
    // 当日に評価したカードは学習中として先に出る(新規より前)。
    // 2 回評価した 1 枚だけは学習ステップを抜けて復習に進み、まだ期限が来ていない。
    expect(tomorrow.cards.filter((c) => c.queue === "learning")).toHaveLength(9);
    expect(tomorrow.cards.slice(0, 9).every((c) => c.queue === "learning")).toBe(true);
  });

  it("JST 0 時の 1 ミリ秒前はまだ当日(枠は空かない)", async () => {
    const fronts = Array.from({ length: 11 }, (_, i) => `v${String(i).padStart(2, "0")}`);
    const ids = await importCards(fronts);
    await startNew(ids, fronts.slice(0, 10));

    const lastMoment = new Date(NEXT_JST_DAY.getTime() - 1);
    vi.setSystemTime(lastMoment);
    const eve = await due("?limit=100", await createAccessHarness(lastMoment));
    expect(eve.new_today).toBe(10);
    expect(eve.new_remaining).toBe(0);
    expect(eve.cards.filter((c) => c.queue === "new")).toEqual([]);
  });

  it("前の日に初回評価したカードは当日の枠を使わない", async () => {
    const cardId = await importOne("yesterday");
    // 前日(JST)に初回評価した行を直接入れる。
    await env.DB.prepare(
      `INSERT INTO reviews (review_id, card_id, rating, occurred_at, received_at, state_before,
         state_after, review_log, fsrs_version, params_version)
       VALUES ('old', ?, 3, '2026-10-25T01:00:00.000Z', '2026-10-25T01:00:00.000Z', '{}', '{}', '{}', ?, 1)`,
    )
      .bind(cardId, FSRSVersion)
      .run();

    const body = await due();
    expect(body.new_today).toBe(0);
    expect(body.new_remaining).toBe(10);
  });
});

describe("GET /api/due(デッキ)", () => {
  it("取り込みが作った固定デッキのカードを返す", async () => {
    await importOne();
    const row = await env.DB.prepare("SELECT deck_id FROM cards").first<{ deck_id: string }>();
    expect(row?.deck_id).toBe(DEFAULT_DECK_ID);
    expect((await due()).cards).toHaveLength(1);
  });
});
