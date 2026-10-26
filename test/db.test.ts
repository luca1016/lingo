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
  type CardStateRow,
  commitReview,
  countNewStartedBetween,
  DEFAULT_DECK_ID,
  findCardIdsByFront,
  getCard,
  getCardIncludingDeleted,
  getCardState,
  getDeck,
  getImport,
  getReview,
  getSettings,
  insertImport,
  insertReview,
  listDueCards,
  type NewImportedCard,
  type NewReview,
  saveCardState,
} from "../src/worker/db";
import { applyReview, toCardStateRow } from "../src/worker/fsrs";
import { dayWindow, toUtcIso } from "../src/worker/time";

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
    env.DB.prepare("DELETE FROM imports"),
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

describe("commitReview(1 batch で条件付き UPDATE + INSERT)", () => {
  const REVIEW_ID = "77777777-6666-4555-8444-333333333333";

  /** 新規の card_state を持つカードを 1 枚用意する(version 1)。 */
  async function seedNew(): Promise<CardStateRow> {
    await seedCard();
    const state = toCardStateRow(CARD_ID, createEmptyCard(NOW), 1, NOW);
    await saveCardState(env.DB, state, 0);
    return state;
  }

  function commitArgs(state: CardStateRow, reviewId = REVIEW_ID) {
    const applied = applyReview({
      state,
      rating: 3,
      occurredAt: NOW,
      receivedAt: NOW,
      parameters: generatorParameters(),
    });
    return {
      review: {
        review_id: reviewId,
        card_id: CARD_ID,
        rating: 3,
        occurred_at: NOW,
        received_at: NOW,
        elapsed_ms: 1200,
        state_before: applied.state_before,
        state_after: applied.state_after,
        review_log: applied.review_log,
        fsrs_version: applied.fsrs_version,
        params_version: 1,
      },
      next: applied.state_after,
      expectedVersion: state.version,
    };
  }

  it("version が合えば state が進み、reviews が 1 行入る", async () => {
    const state = await seedNew();
    const args = commitArgs(state);
    expect(await commitReview(env.DB, args)).toBe(true);

    expect(await getCardState(env.DB, CARD_ID)).toEqual(args.next);
    const row = await getReview(env.DB, REVIEW_ID);
    expect(row?.card_id).toBe(CARD_ID);
    // version_before は state_before.version と同じ値(batch の条件付き UPDATE が見る)。
    expect(row?.version_before).toBe(state.version);
    expect(JSON.parse(row?.state_before ?? "null")).toEqual(state);
    expect(JSON.parse(row?.state_after ?? "null")).toEqual(args.next);
    expect(row?.fsrs_version).toBe(FSRSVersion);
  });

  it("先に別の評価が入っていたら 1 行も書かない(reviews も増えない)", async () => {
    const state = await seedNew();
    expect(await commitReview(env.DB, commitArgs(state))).toBe(true);
    const after = await getCardState(env.DB, CARD_ID);

    // 同じ version(= 古い)のまま別の review_id で来たもの。
    const stale = commitArgs(state, "66666666-5555-4444-8333-222222222222");
    expect(await commitReview(env.DB, stale)).toBe(false);

    expect(await getCardState(env.DB, CARD_ID)).toEqual(after);
    expect(await getReview(env.DB, "66666666-5555-4444-8333-222222222222")).toBeNull();
    const counted = await env.DB.prepare("SELECT COUNT(*) AS n FROM reviews").first<{
      n: number;
    }>();
    expect(counted?.n).toBe(1);
  });

  it("同じ review_id の二重確定は state を 2 回進めない", async () => {
    const state = await seedNew();
    expect(await commitReview(env.DB, commitArgs(state))).toBe(true);
    // 1 回目と同じ引数(= 再送)。version はもう合わないので false。
    expect(await commitReview(env.DB, commitArgs(state))).toBe(false);
    expect((await getCardState(env.DB, CARD_ID))?.version).toBe(2);
    const counted = await env.DB.prepare("SELECT COUNT(*) AS n FROM reviews").first<{
      n: number;
    }>();
    expect(counted?.n).toBe(1);
  });

  it("同じ review_id が別の version から使われていたら、version が合っていても進めない", async () => {
    const state = await seedNew();
    expect(await commitReview(env.DB, commitArgs(state))).toBe(true);

    // 今の version(2)からもう 1 回、同じ冪等キーで確定しようとしたもの。
    // version の条件は満たすが、INSERT は冪等キーの衝突で無視されるので UPDATE も 0 件になる
    // (= 同じ review_id で state が 2 回進まない)。
    const current = (await getCardState(env.DB, CARD_ID)) as CardStateRow;
    expect(current.version).toBe(2);
    expect(await commitReview(env.DB, commitArgs(current))).toBe(false);

    expect(await getCardState(env.DB, CARD_ID)).toEqual(current);
    expect((await getReview(env.DB, REVIEW_ID))?.version_before).toBe(1);
    const counted = await env.DB.prepare("SELECT COUNT(*) AS n FROM reviews").first<{
      n: number;
    }>();
    expect(counted?.n).toBe(1);
  });

  it("state_before.version が expectedVersion と食い違えば呼び出し側の誤りとして投げる", async () => {
    const state = await seedNew();
    const args = commitArgs(state);
    await expect(
      commitReview(env.DB, { ...args, expectedVersion: args.expectedVersion + 1 }),
    ).rejects.toThrow(/version/);
  });

  it("同じ review_id が別のカードに使われていたら、そのカードの state も進めない", async () => {
    const state = await seedNew();
    expect(await commitReview(env.DB, commitArgs(state))).toBe(true);

    // 同じ冪等キーを別のカードで(version は合っている状態で)確定しようとしたもの。
    const otherId = "99999999-8888-4777-8666-555555555555";
    await seedCard(otherId);
    const otherState = toCardStateRow(otherId, createEmptyCard(NOW), 1, NOW);
    await saveCardState(env.DB, otherState, 0);
    const applied = applyReview({
      state: otherState,
      rating: 3,
      occurredAt: NOW,
      receivedAt: NOW,
      parameters: generatorParameters(),
    });
    const other = commitArgs(state);
    expect(
      await commitReview(env.DB, {
        review: {
          ...other.review,
          card_id: otherId,
          state_before: otherState,
          state_after: applied.state_after,
        },
        next: applied.state_after,
        expectedVersion: otherState.version,
      }),
    ).toBe(false);

    // ログは 1 回目(CARD_ID)の 1 行だけ。別のカードの state は動いていない。
    expect(await getCardState(env.DB, otherId)).toEqual(otherState);
    expect((await getReview(env.DB, REVIEW_ID))?.card_id).toBe(CARD_ID);
    const counted = await env.DB.prepare("SELECT COUNT(*) AS n FROM reviews").first<{
      n: number;
    }>();
    expect(counted?.n).toBe(1);
  });
});

describe("出題候補の問い合わせ", () => {
  /** カード 1 枚と、指定した FSRS 状態の card_state を入れる。 */
  async function seedStated(params: {
    id: string;
    front: string;
    fsrsState: number;
    due: Date;
    createdAt?: Date;
  }) {
    const at = toUtcIso(params.createdAt ?? NOW);
    await env.DB.prepare(
      `INSERT INTO cards (id, deck_id, front, back, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(params.id, DEFAULT_DECK_ID, params.front, `${params.front} の意味`, at, at)
      .run();
    await env.DB.prepare(
      `INSERT INTO card_state (card_id, due, stability, difficulty, elapsed_days, scheduled_days,
         learning_steps, reps, lapses, fsrs_state, last_review, version, updated_at)
       VALUES (?, ?, 1.0, 5.0, 0, 0, 0, 1, 0, ?, NULL, 3, ?)`,
    )
      .bind(params.id, toUtcIso(params.due), params.fsrsState, at)
      .run();
  }

  const id = (n: number) => `aaaaaaaa-0000-4000-8000-00000000000${n}`;

  it("待ち行列ごとに期限到来だけを due の古い順で返す", async () => {
    await seedStated({
      id: id(1),
      front: "learn-late",
      fsrsState: 1,
      due: new Date(NOW.getTime() - 60_000),
    });
    await seedStated({
      id: id(2),
      front: "learn-early",
      fsrsState: 3,
      due: new Date(NOW.getTime() - 120_000),
    });
    await seedStated({
      id: id(3),
      front: "learn-future",
      fsrsState: 1,
      due: new Date(NOW.getTime() + 1),
    });
    await seedStated({ id: id(4), front: "review-due", fsrsState: 2, due: NOW });
    await seedStated({
      id: id(5),
      front: "review-future",
      fsrsState: 2,
      due: new Date(NOW.getTime() + 60_000),
    });
    await seedStated({
      id: id(6),
      front: "new",
      fsrsState: 0,
      due: new Date(NOW.getTime() + 60_000),
    });

    const learning = await listDueCards(env.DB, { queue: "learning", now: NOW, limit: 10 });
    expect(learning.map((r) => r.front)).toEqual(["learn-early", "learn-late"]);
    expect(learning[0]?.version).toBe(3);

    const review = await listDueCards(env.DB, { queue: "review", now: NOW, limit: 10 });
    expect(review.map((r) => r.front)).toEqual(["review-due"]);

    // 新規は期限を見ない(上限で絞るのは呼び出し側)。
    const fresh = await listDueCards(env.DB, { queue: "new", now: NOW, limit: 10 });
    expect(fresh.map((r) => r.front)).toEqual(["new"]);

    expect(await listDueCards(env.DB, { queue: "new", now: NOW, limit: 0 })).toEqual([]);
  });

  it("論理削除したカードは出てこない", async () => {
    await seedStated({ id: id(1), front: "gone", fsrsState: 2, due: NOW });
    await env.DB.prepare("UPDATE cards SET deleted_at = ? WHERE id = ?")
      .bind(toUtcIso(NOW), id(1))
      .run();
    expect(await listDueCards(env.DB, { queue: "review", now: NOW, limit: 10 })).toEqual([]);
  });

  it("新規は作った順に出る", async () => {
    await seedStated({
      id: id(1),
      front: "later",
      fsrsState: 0,
      due: NOW,
      createdAt: new Date(NOW.getTime() + 1000),
    });
    await seedStated({ id: id(2), front: "sooner", fsrsState: 0, due: NOW, createdAt: NOW });
    const fresh = await listDueCards(env.DB, { queue: "new", now: NOW, limit: 10 });
    expect(fresh.map((r) => r.front)).toEqual(["sooner", "later"]);
  });

  it("初回評価の枚数は範囲内のユニーク枚数(同じカードの 2 回目は数えない)", async () => {
    await seedCard();
    const { start, end } = dayWindow(NOW, "Asia/Tokyo");
    const insert = async (reviewId: string, cardId: string, occurredAt: Date) => {
      await env.DB.prepare(
        `INSERT INTO reviews (review_id, card_id, rating, occurred_at, received_at, state_before,
           state_after, review_log, fsrs_version, params_version)
         VALUES (?, ?, 3, ?, ?, '{}', '{}', '{}', ?, 1)`,
      )
        .bind(reviewId, cardId, toUtcIso(occurredAt), toUtcIso(occurredAt), FSRSVersion)
        .run();
    };

    expect(await countNewStartedBetween(env.DB, start, end)).toBe(0);

    await insert("r1", CARD_ID, NOW);
    await insert("r2", CARD_ID, new Date(NOW.getTime() + 60_000));
    expect(await countNewStartedBetween(env.DB, start, end)).toBe(1);

    // 前の日に初回評価したカードは、今日の枠を使わない。
    await seedCard(id(9));
    await insert("r3", id(9), new Date(start.getTime() - 1));
    await insert("r4", id(9), NOW);
    expect(await countNewStartedBetween(env.DB, start, end)).toBe(1);

    // 範囲は start 以上 end 未満。
    expect(await countNewStartedBetween(env.DB, new Date(start.getTime() - 1), start)).toBe(1);
    expect(await countNewStartedBetween(env.DB, end, new Date(end.getTime() + 1))).toBe(0);
  });
});

describe("imports(冪等キーと一括投入)", () => {
  const IMPORT_ID = "aaaa1111-2222-4333-8444-555555555555";

  function newCard(id: string, front: string): NewImportedCard {
    return {
      id,
      front,
      back: `${front} の意味`,
      example: null,
      note: null,
      state: toCardStateRow(id, createEmptyCard(NOW), 1, NOW),
    };
  }

  it("cards・card_state・imports を 1 回で書き、再送は result から返せる", async () => {
    const cards = [newCard(CARD_ID, "invoice")];
    await insertImport(env.DB, {
      importId: IMPORT_ID,
      receivedAt: NOW,
      result: { import_id: IMPORT_ID, added: 1 },
      cards,
    });

    expect((await getCard(env.DB, CARD_ID))?.front).toBe("invoice");
    expect(await getCardState(env.DB, CARD_ID)).toEqual(cards[0]?.state);

    const row = await getImport(env.DB, IMPORT_ID);
    expect(row?.received_at).toBe(toUtcIso(NOW));
    expect(row?.added).toBe(1);
    expect(JSON.parse(row?.result ?? "null")).toEqual({ import_id: IMPORT_ID, added: 1 });
    expect(await getImport(env.DB, "no-such-import")).toBeNull();
  });

  it("途中で失敗したら 1 行も入らない(import_id の衝突)", async () => {
    await insertImport(env.DB, {
      importId: IMPORT_ID,
      receivedAt: NOW,
      result: { added: 0 },
      cards: [],
    });

    await expect(
      insertImport(env.DB, {
        importId: IMPORT_ID,
        receivedAt: NOW,
        result: { added: 1 },
        cards: [newCard(CARD_ID, "invoice")],
      }),
    ).rejects.toThrow();

    expect(await getCard(env.DB, CARD_ID)).toBeNull();
    expect(await getCardState(env.DB, CARD_ID)).toBeNull();
    expect(JSON.parse((await getImport(env.DB, IMPORT_ID))?.result ?? "null")).toEqual({
      added: 0,
    });
  });

  it("D1 の bind 上限を超える件数でも分割して入れられる", async () => {
    const cards = Array.from({ length: 120 }, (_, i) =>
      newCard(`cccccccc-dddd-4eee-8fff-${String(i).padStart(12, "0")}`, `w${i}`),
    );
    await insertImport(env.DB, {
      importId: IMPORT_ID,
      receivedAt: NOW,
      result: { added: cards.length },
      cards,
    });

    const counted = await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM cards) AS cards, (SELECT COUNT(*) FROM card_state) AS states",
    ).first<{ cards: number; states: number }>();
    expect(counted).toEqual({ cards: 120, states: 120 });
  });

  it("生きているカードだけ front で引ける", async () => {
    await insertImport(env.DB, {
      importId: IMPORT_ID,
      receivedAt: NOW,
      result: {},
      cards: [newCard(CARD_ID, "invoice")],
    });

    expect(await findCardIdsByFront(env.DB, ["invoice", "ledger"])).toEqual(
      new Map([["invoice", CARD_ID]]),
    );
    expect(await findCardIdsByFront(env.DB, [])).toEqual(new Map());

    await env.DB.prepare("UPDATE cards SET deleted_at = ? WHERE id = ?")
      .bind(toUtcIso(NOW), CARD_ID)
      .run();
    expect(await findCardIdsByFront(env.DB, ["invoice"])).toEqual(new Map());
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
