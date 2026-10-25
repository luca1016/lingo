import { env } from "cloudflare:workers";
import { type Card, createEmptyCard, fsrs, generatorParameters, Rating, State } from "ts-fsrs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DECK_ID, getCardState, saveCardState } from "../src/worker/db";
import { toCardStateRow, toFsrsCard } from "../src/worker/fsrs";
import { fromUtcIso, toUtcIso } from "../src/worker/time";

// 固定時計。NOW は UTC では 10/24、JST では 10/25(= 日付の境界をまたぐ値)。
const NOW = new Date("2026-10-24T15:00:00.000Z");
const CARD_ID = "22222222-3333-4444-8555-666666666666";

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

// D1 はテスト間で共有されるので、書き込む表は毎回空にしてから始める。
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM card_state"),
    env.DB.prepare("DELETE FROM cards"),
  ]);
});

/** その瞬間の JST のカレンダー日付("YYYY-MM-DD")。 */
function jstDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** 解答を 1 回通したカード(last_review などが埋まっている状態)。 */
function reviewedCard(): Card {
  return fsrs(generatorParameters()).next(createEmptyCard(NOW), NOW, Rating.Good).card;
}

describe("ts-fsrs Card <-> card_state 行", () => {
  it("新規カードの往復で全フィールドが一致する", () => {
    const card = createEmptyCard(NOW);
    const row = toCardStateRow(CARD_ID, card, 1, NOW);

    expect(row.card_id).toBe(CARD_ID);
    expect(row.state).toBe(State.New);
    expect(row.last_review).toBeNull();
    expect(row.version).toBe(1);
    expect(toFsrsCard(row)).toStrictEqual(card);
  });

  it("解答後のカードの往復で全フィールドが一致する", () => {
    const card = reviewedCard();
    expect(card.last_review).toBeInstanceOf(Date);

    const back = toFsrsCard(toCardStateRow(CARD_ID, card, 2, NOW));
    expect(back).toStrictEqual(card);
    expect(back.due.getTime()).toBe(card.due.getTime());
    expect(back.last_review?.getTime()).toBe(card.last_review?.getTime());
  });

  it("4 つの state すべてで往復する", () => {
    for (const state of [State.New, State.Learning, State.Review, State.Relearning]) {
      const card: Card = { ...reviewedCard(), state };
      expect(toFsrsCard(toCardStateRow(CARD_ID, card, 1, NOW)), State[state]).toStrictEqual(card);
    }
  });

  it("行の時刻は UTC の ISO 8601 文字列で、ローカル表現を持ち込まない", () => {
    const row = toCardStateRow(CARD_ID, reviewedCard(), 1, NOW);
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    expect(row.due).toMatch(iso);
    expect(row.updated_at).toBe("2026-10-24T15:00:00.000Z");
    expect(row.last_review).toBe("2026-10-24T15:00:00.000Z");
  });

  it("D1 に書いて読み戻しても Card が変わらない", async () => {
    await env.DB.prepare(
      `INSERT INTO cards (id, deck_id, term, meaning, created_at, updated_at)
       VALUES (?, ?, 'invoice', '請求書', ?, ?)`,
    )
      .bind(CARD_ID, DEFAULT_DECK_ID, toUtcIso(NOW), toUtcIso(NOW))
      .run();

    const card = reviewedCard();
    await saveCardState(env.DB, toCardStateRow(CARD_ID, card, 1, NOW), 0);

    const stored = await getCardState(env.DB, CARD_ID);
    expect(stored).not.toBeNull();
    expect(stored && toFsrsCard(stored)).toStrictEqual(card);
  });
});

describe("時刻の往復(UTC 保存)", () => {
  // JST の日付境界(UTC 15:00)をまたぐ値を並べる
  const samples = [
    "2026-10-24T14:59:59.999Z", // JST 2026-10-24 23:59:59.999
    "2026-10-24T15:00:00.000Z", // JST 2026-10-25 00:00:00.000
    "2026-10-24T15:00:00.001Z",
    "2026-12-31T15:00:00.000Z", // JST では年が変わる
    "2026-01-01T00:00:00.000Z",
  ];

  it("Date -> 文字列 -> Date で値が変わらない", () => {
    for (const iso of samples) {
      const date = new Date(iso);
      expect(toUtcIso(date), iso).toBe(iso);
      expect(fromUtcIso(toUtcIso(date)).getTime(), iso).toBe(date.getTime());
    }
  });

  it("JST の日付が変わる前後でも、保存値は UTC のままずれない", () => {
    const eve = fromUtcIso("2026-10-24T14:59:59.999Z");
    const midnight = fromUtcIso("2026-10-24T15:00:00.000Z");
    expect(jstDate(eve)).toBe("2026-10-24");
    expect(jstDate(midnight)).toBe("2026-10-25");
    // 往復しても JST から見た日付も UTC の文字列も変わらない
    expect(jstDate(fromUtcIso(toUtcIso(eve)))).toBe("2026-10-24");
    expect(jstDate(fromUtcIso(toUtcIso(midnight)))).toBe("2026-10-25");
    expect(toUtcIso(midnight)).toBe("2026-10-24T15:00:00.000Z");
  });

  it("オフセット付きの入力も UTC に正規化して保存される", () => {
    const jstMidnight = fromUtcIso("2026-10-25T00:00:00.000+09:00");
    expect(toUtcIso(jstMidnight)).toBe("2026-10-24T15:00:00.000Z");
  });

  it("D1 に書いて読み戻しても同じ文字列・同じ瞬間", async () => {
    await env.DB.prepare(
      `INSERT INTO cards (id, deck_id, term, meaning, created_at, updated_at)
       VALUES (?, ?, 'invoice', '請求書', ?, ?)`,
    )
      .bind(CARD_ID, DEFAULT_DECK_ID, toUtcIso(NOW), toUtcIso(NOW))
      .run();

    let version = 0;
    for (const iso of samples) {
      const card: Card = { ...reviewedCard(), due: fromUtcIso(iso) };
      version += 1;
      await saveCardState(env.DB, toCardStateRow(CARD_ID, card, version, NOW), version - 1);
      const stored = await getCardState(env.DB, CARD_ID);
      expect(stored?.due, iso).toBe(iso);
      expect(stored && toFsrsCard(stored).due.getTime(), iso).toBe(new Date(iso).getTime());
    }
  });

  it("壊れた値は読み出しで気づける", () => {
    expect(() => fromUtcIso("not a date")).toThrow(RangeError);
    expect(() => toUtcIso(new Date("not a date"))).toThrow(RangeError);
  });
});
