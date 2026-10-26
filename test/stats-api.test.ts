// GET /api/stats(Issue 5)を実 App + ローカル D1 で動かす。固定時計で 4 指標を押さえる:
//  - 今 due / 今日中 due(JST の当日末まで。0 時を跨ぐと入れ替わる)
//  - 総数(論理削除を除く)
//  - 連続日数(評価確定日 = JST の日付ベース。途切れる・今日まだ評価していない場合を含む)

import { env } from "cloudflare:workers";
import { FSRSVersion, State } from "ts-fsrs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportResponse } from "../src/shared/cards";
import type { StatsResponse } from "../src/shared/stats";
import { toUtcIso } from "../src/worker/time";
import { type AccessHarness, createAccessHarness, ORIGIN } from "./access-harness";

// 固定時計。NOW は JST では 2026-10-26 10:23(当日の窓は UTC 10-25 15:00 〜 10-26 15:00)。
const NOW = new Date("2026-10-26T01:23:45.000Z");
/** JST の 0 時(= UTC 15:00)。ここを跨ぐと「今日」が変わる。 */
const NEXT_JST_DAY = new Date("2026-10-26T15:00:00.000Z");
/** その次の JST 0 時(= 2 日目の境界)。 */
const SECOND_JST_DAY = new Date("2026-10-27T15:00:00.000Z");
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

/** GET /api/stats(その時刻の JWT を持つ harness で引く)。 */
async function stats(h: AccessHarness = harness): Promise<StatsResponse> {
  const res = await h.app.request(
    `${ORIGIN}/api/stats`,
    { headers: { "Cf-Access-Jwt-Assertion": h.jwt } },
    h.env,
  );
  expect(res.status).toBe(200);
  return await res.json<StatsResponse>();
}

/** その時刻の時計と JWT で GET /api/stats を引く。 */
async function statsAt(at: Date): Promise<StatsResponse> {
  vi.setSystemTime(at);
  return await stats(await createAccessHarness(at));
}

/** 取り込み経路(POST /api/cards)でカードを作り、front -> card_id を返す。 */
async function importCards(fronts: readonly string[]): Promise<Map<string, string>> {
  const res = await post("/api/cards", {
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

/** card_state を直接書く(期限と状態を作り分ける)。 */
async function setState(cardId: string, fsrsState: number, dueAt: Date) {
  await env.DB.prepare(
    "UPDATE card_state SET fsrs_state = ?, due = ?, updated_at = ? WHERE card_id = ?",
  )
    .bind(fsrsState, toUtcIso(dueAt), toUtcIso(NOW), cardId)
    .run();
}

/** 論理削除する(行は残す)。 */
async function deleteCard(cardId: string) {
  await env.DB.prepare("UPDATE cards SET deleted_at = ? WHERE id = ?")
    .bind(toUtcIso(NOW), cardId)
    .run();
}

let reviewSeq = 0;

/** 評価を 1 件、指定した occurred_at で直接入れる(連続日数の材料)。 */
async function reviewAt(cardId: string, occurredAt: string) {
  reviewSeq += 1;
  await env.DB.prepare(
    `INSERT INTO reviews (review_id, card_id, rating, occurred_at, received_at, state_before,
       state_after, review_log, fsrs_version, params_version)
     VALUES (?, ?, 3, ?, ?, '{}', '{}', '{}', ?, 1)`,
  )
    .bind(`seeded-${reviewSeq}`, cardId, occurredAt, occurredAt, FSRSVersion)
    .run();
}

/** 連続日数だけを見る(カード 1 枚に、与えた時刻の評価を入れる)。 */
async function streakOf(occurredAts: readonly string[]): Promise<number> {
  const cardId = await importOne("streak");
  for (const at of occurredAts) await reviewAt(cardId, at);
  return (await stats()).streak_days;
}

describe("GET /api/stats(枚数)", () => {
  it("カードが 1 枚も無ければ 4 指標すべて 0", async () => {
    expect(await stats()).toMatchObject({
      now: toUtcIso(NOW),
      due_now: 0,
      due_today: 0,
      total: 0,
      streak_days: 0,
    });
  });

  it("期限が来たものを今 due、当日末までのものを今日中 due に数える(新規は数えない)", async () => {
    const ids = await importCards(["past", "tonight", "midnight", "fresh"]);
    // 期限切れ(学習中)。
    await setState(ids.get("past") as string, State.Learning, new Date(NOW.getTime() - MINUTE));
    // 今日のうちに来る(JST 23:59 = UTC 14:59)。
    await setState(
      ids.get("tonight") as string,
      State.Review,
      new Date(NEXT_JST_DAY.getTime() - MINUTE),
    );
    // JST 0 時ちょうどは翌日ぶん(当日末は含めない)。
    await setState(ids.get("midnight") as string, State.Review, NEXT_JST_DAY);
    // "fresh" は取り込んだままの新規(due は作った時刻 = いま)。期限では数えない。

    expect(await stats()).toMatchObject({ due_now: 1, due_today: 2, total: 4 });
  });

  it("論理削除したカードはどの数にも入らない", async () => {
    const ids = await importCards(["alive", "removed"]);
    const past = new Date(NOW.getTime() - MINUTE);
    await setState(ids.get("alive") as string, State.Review, past);
    await setState(ids.get("removed") as string, State.Review, past);
    await deleteCard(ids.get("removed") as string);

    expect(await stats()).toMatchObject({ due_now: 1, due_today: 1, total: 1 });
  });

  it("JST 0 時を跨ぐと、今日中 due と今 due が入れ替わる", async () => {
    const ids = await importCards(["tonight", "tomorrow"]);
    // JST 23:59(= UTC 14:59)と、翌 JST 0:30(= UTC 15:30)。
    await setState(
      ids.get("tonight") as string,
      State.Review,
      new Date(NEXT_JST_DAY.getTime() - MINUTE),
    );
    await setState(
      ids.get("tomorrow") as string,
      State.Review,
      new Date(NEXT_JST_DAY.getTime() + 30 * MINUTE),
    );

    // 今日のうちは 1 枚だけ(翌日ぶんは数えない)。まだどちらも期限は来ていない。
    expect(await stats()).toMatchObject({ due_now: 0, due_today: 1, total: 2 });

    // JST 0 時を跨ぐと「今日」が変わり、今夜ぶんは期限切れ、翌 0:30 ぶんが今日中になる。
    expect(await statsAt(NEXT_JST_DAY)).toMatchObject({ due_now: 1, due_today: 2, total: 2 });
  });

  it("評価を確定すると、その日の連続日数が立ち、期限は次の学習ステップに動く", async () => {
    const cardId = await importOne();
    const res = await post("/api/review", {
      review_id: "stats-review-1",
      card_id: cardId,
      rating: 3,
      expected_version: 1,
      occurred_at: toUtcIso(NOW),
      elapsed_ms: 1200,
    });
    expect(res.status).toBe(200);

    // Good の次は学習ステップの 10 分後(いまは期限切れではないが、今日のうちに来る)。
    expect(await stats()).toMatchObject({
      due_now: 0,
      due_today: 1,
      total: 1,
      streak_days: 1,
    });
  });
});

describe("GET /api/stats(連続日数)", () => {
  it("今日まで続いていれば今日を含めて数える", async () => {
    expect(
      await streakOf([
        "2026-10-26T01:00:00.000Z", // JST 10-26(今日)
        "2026-10-25T01:00:00.000Z", // JST 10-25
        "2026-10-24T23:00:00.000Z", // JST 10-25 の 8 時 — 同じ日なので 1 日ぶん
        "2026-10-23T22:00:00.000Z", // JST 10-24 の 7 時
      ]),
    ).toBe(3);
  });

  it("途切れた日より前は数えない", async () => {
    expect(
      await streakOf([
        "2026-10-26T01:00:00.000Z", // JST 10-26(今日)
        "2026-10-25T01:00:00.000Z", // JST 10-25
        // JST 10-24 は評価していない(ここで途切れる)
        "2026-10-23T01:00:00.000Z", // JST 10-23
        "2026-10-22T01:00:00.000Z", // JST 10-22
      ]),
    ).toBe(2);
  });

  it("今日まだ評価していなければ、前日までの連続を返す(日の途中で 0 にしない)", async () => {
    expect(
      await streakOf([
        "2026-10-25T01:00:00.000Z", // JST 10-25(前日)
        "2026-10-24T01:00:00.000Z", // JST 10-24
      ]),
    ).toBe(2);
  });

  it("今日も前日も評価していなければ 0", async () => {
    expect(
      await streakOf([
        "2026-10-24T01:00:00.000Z", // JST 10-24(前々日)
        "2026-10-23T01:00:00.000Z",
      ]),
    ).toBe(0);
  });

  it("同じ日に何回評価しても 1 日として数える", async () => {
    expect(
      await streakOf([
        "2026-10-26T01:00:00.000Z",
        "2026-10-26T02:00:00.000Z",
        "2026-10-26T03:00:00.000Z",
      ]),
    ).toBe(1);
  });

  it("日付は JST で決める(UTC の日付では区切らない)", async () => {
    // UTC では同じ 10-25 だが、JST では 10-26 の 0 時と 10-25 の 23:59。
    expect(await streakOf(["2026-10-25T15:00:00.000Z", "2026-10-25T14:59:59.000Z"])).toBe(2);
  });

  it("JST 0 時を跨いで評価しなければ、連続は途切れる", async () => {
    const cardId = await importOne("across-midnight");
    await reviewAt(cardId, "2026-10-26T01:00:00.000Z"); // JST 10-26
    await reviewAt(cardId, "2026-10-25T01:00:00.000Z"); // JST 10-25
    expect((await stats()).streak_days).toBe(2);

    // JST 10-27 の 0 時。今日はまだ評価していないが、前日(10-26)までは続いている。
    expect((await statsAt(NEXT_JST_DAY)).streak_days).toBe(2);

    // さらに 1 日なにもしないまま JST 10-28 に入ると、今日も前日も無いので途切れる。
    expect((await statsAt(SECOND_JST_DAY)).streak_days).toBe(0);
  });
});

describe("GET /api/stats(Access)", () => {
  it("Access JWT が無ければ 401", async () => {
    const res = await harness.app.request(`${ORIGIN}/api/stats`, {}, harness.env);
    expect(res.status).toBe(401);
  });
});
