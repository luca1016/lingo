import { env } from "cloudflare:workers";
import {
  createEmptyCard,
  default_enable_fuzz,
  default_enable_short_term,
  default_maximum_interval,
  default_request_retention,
  FSRSVersion,
  fsrs,
  generatorParameters,
  Rating,
} from "ts-fsrs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DECK_ID,
  getCard,
  getCardIncludingDeleted,
  getCardState,
  getDeck,
  getReview,
  getSettings,
  insertReview,
  type NewReview,
  saveCardState,
} from "../src/worker/db";
import { toCardStateRow } from "../src/worker/fsrs";
import { toUtcIso } from "../src/worker/time";

const NOW = new Date("2026-10-24T15:00:00.000Z"); // JST では 2026-10-25 00:00
const CARD_ID = "11111111-2222-4333-8444-555555555555";

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

// D1 はテスト間で共有されるので、書き込む表は毎回空にしてから始める(migration が入れた行は消さない)。
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM reviews"),
    env.DB.prepare("DELETE FROM card_state"),
    env.DB.prepare("DELETE FROM cards"),
  ]);
});

/** カードの投入はまだ永続化層に無い(CSV import の Issue)ので、テストは SQL で用意する。 */
async function seedCard(id = CARD_ID, deletedAt: string | null = null) {
  await env.DB.prepare(
    `INSERT INTO cards (id, deck_id, front, back, example, note, created_at, updated_at, deleted_at)
     VALUES (?, ?, 'invoice', '請求書', 'Please send the invoice.', NULL, ?, ?, ?)`,
  )
    .bind(id, DEFAULT_DECK_ID, toUtcIso(NOW), toUtcIso(NOW), deletedAt)
    .run();
}

describe("cards / decks", () => {
  beforeEach(async () => {
    await seedCard();
  });

  it("固定デッキを id 省略で取れる", async () => {
    const deck = await getDeck(env.DB);
    expect(deck?.id).toBe(DEFAULT_DECK_ID);
  });

  it("カードを取れる", async () => {
    const card = await getCard(env.DB, CARD_ID);
    expect(card?.front).toBe("invoice");
    expect(card?.back).toBe("請求書");
    expect(card?.deck_id).toBe(DEFAULT_DECK_ID);
    expect(card?.deleted_at).toBeNull();
  });

  it("無い id は null", async () => {
    expect(await getCard(env.DB, "no-such-card")).toBeNull();
  });

  it("論理削除したカードは getCard では見えないが、行は残っている", async () => {
    await env.DB.prepare("UPDATE cards SET deleted_at = ? WHERE id = ?")
      .bind(toUtcIso(NOW), CARD_ID)
      .run();
    expect(await getCard(env.DB, CARD_ID)).toBeNull();
    const row = await getCardIncludingDeleted(env.DB, CARD_ID);
    expect(row?.deleted_at).toBe(toUtcIso(NOW));
  });
});

describe("card_state(楽観ロック)", () => {
  beforeEach(async () => {
    await seedCard();
  });

  it("初回は null、version 1 で入れられる", async () => {
    expect(await getCardState(env.DB, CARD_ID)).toBeNull();

    const row = toCardStateRow(CARD_ID, createEmptyCard(NOW), 1, NOW);
    expect(await saveCardState(env.DB, row, 0)).toBe(true);

    const stored = await getCardState(env.DB, CARD_ID);
    expect(stored).toEqual(row);
  });

  it("version が合えば更新でき、合わなければ何も書かない", async () => {
    const first = toCardStateRow(CARD_ID, createEmptyCard(NOW), 1, NOW);
    await saveCardState(env.DB, first, 0);

    const scheduled = fsrs(generatorParameters()).next(createEmptyCard(NOW), NOW, Rating.Good).card;
    const second = toCardStateRow(CARD_ID, scheduled, 2, NOW);
    expect(await saveCardState(env.DB, second, 1)).toBe(true);
    expect(await getCardState(env.DB, CARD_ID)).toEqual(second);

    // 古い version のまま書こうとしたら弾かれ、DB は second のまま
    const stale = toCardStateRow(CARD_ID, scheduled, 2, NOW);
    expect(await saveCardState(env.DB, stale, 1)).toBe(false);
    expect((await getCardState(env.DB, CARD_ID))?.version).toBe(2);
  });

  it("初回の二重挿入は false になる", async () => {
    const row = toCardStateRow(CARD_ID, createEmptyCard(NOW), 1, NOW);
    expect(await saveCardState(env.DB, row, 0)).toBe(true);
    expect(await saveCardState(env.DB, row, 0)).toBe(false);
  });

  it("version が expectedVersion + 1 でなければ呼び出し側の誤りとして投げる", async () => {
    const row = toCardStateRow(CARD_ID, createEmptyCard(NOW), 5, NOW);
    await expect(saveCardState(env.DB, row, 0)).rejects.toThrow(/version/);
  });
});

describe("reviews(冪等キー)", () => {
  const REVIEW_ID = "99999999-8888-4777-8666-555555555555";

  function newReview(id = REVIEW_ID, correctionOf: string | null = null): NewReview {
    const before = createEmptyCard(NOW);
    const { card, log } = fsrs(generatorParameters()).next(before, NOW, Rating.Good);
    return {
      review_id: id,
      card_id: CARD_ID,
      rating: Rating.Good,
      occurred_at: NOW,
      received_at: new Date(NOW.getTime() + 1500),
      elapsed_ms: 4200,
      state_before: toCardStateRow(CARD_ID, before, 0, NOW),
      state_after: toCardStateRow(CARD_ID, card, 1, NOW),
      review_log: log,
      fsrs_version: FSRSVersion,
      params_version: 1,
      correction_of: correctionOf,
    };
  }

  beforeEach(async () => {
    await seedCard();
  });

  it("入れた内容をそのまま読み出せる", async () => {
    const review = newReview();
    expect(await insertReview(env.DB, review)).toBe(true);

    const row = await getReview(env.DB, REVIEW_ID);
    expect(row?.card_id).toBe(CARD_ID);
    expect(row?.rating).toBe(Rating.Good);
    expect(row?.occurred_at).toBe(toUtcIso(NOW));
    expect(row?.received_at).toBe(toUtcIso(new Date(NOW.getTime() + 1500)));
    expect(row?.elapsed_ms).toBe(4200);
    expect(row?.fsrs_version).toBe(FSRSVersion);
    expect(row?.params_version).toBe(1);
    expect(row?.correction_of).toBeNull();
    expect(JSON.parse(row?.state_before ?? "null")).toEqual(review.state_before);
    expect(JSON.parse(row?.state_after ?? "null")).toEqual(review.state_after);
    expect(JSON.parse(row?.review_log ?? "null")).toMatchObject({ rating: Rating.Good });
  });

  it("elapsed_ms は省略できる(NULL で入る)", async () => {
    const { elapsed_ms: _omitted, ...review } = newReview();
    expect(await insertReview(env.DB, review)).toBe(true);
    expect((await getReview(env.DB, REVIEW_ID))?.elapsed_ms).toBeNull();
  });

  it("同じ review_id の再送は 1 件のまま(false を返す)", async () => {
    expect(await insertReview(env.DB, newReview())).toBe(true);
    expect(await insertReview(env.DB, newReview())).toBe(false);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM reviews").first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it("訂正は元の行を消さずに correction_of 付きで足す", async () => {
    await insertReview(env.DB, newReview());
    const correctionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    expect(await insertReview(env.DB, newReview(correctionId, REVIEW_ID))).toBe(true);

    expect((await getReview(env.DB, REVIEW_ID))?.correction_of).toBeNull();
    expect((await getReview(env.DB, correctionId))?.correction_of).toBe(REVIEW_ID);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM reviews").first<{ n: number }>();
    expect(row?.n).toBe(2);
  });
});

describe("settings", () => {
  it("初期値は 新規上限 10 / ステップ 1m・10m / Asia/Tokyo / FSRS 既定", async () => {
    const settings = await getSettings(env.DB);
    expect(settings.timezone).toBe("Asia/Tokyo");
    expect(settings.newCardsPerDay).toBe(10);
    expect(settings.paramsVersion).toBe(1);
    expect(settings.fsrs.learning_steps).toEqual(["1m", "10m"]);
    expect(settings.fsrs.request_retention).toBe(default_request_retention);
    expect(settings.fsrs.maximum_interval).toBe(default_maximum_interval);
    expect(settings.fsrs.enable_fuzz).toBe(default_enable_fuzz);
    expect(settings.fsrs.enable_short_term).toBe(default_enable_short_term);
  });

  it("ts-fsrs にそのまま渡せる(既定パラメータと一致する)", async () => {
    const settings = await getSettings(env.DB);
    expect(settings.fsrs).toEqual(generatorParameters());
    // 実際にスケジューラを作れること
    const { card } = fsrs(settings.fsrs).next(createEmptyCard(NOW), NOW, Rating.Good);
    expect(card.reps).toBe(1);
  });
});
