import { toUtcIso } from "../time";
import { updateCardStateStatement } from "./card-state";
import type { CardStateRow, NewReview, ReviewRow } from "./types";

const COLUMNS =
  "review_id, card_id, rating, occurred_at, received_at, elapsed_ms, state_before, state_after, review_log, fsrs_version, params_version, correction_of";

/** insertReview / commitReview が bind する値(COLUMNS と同じ順)。 */
function reviewValues(review: NewReview): unknown[] {
  return [
    review.review_id,
    review.card_id,
    review.rating,
    toUtcIso(review.occurred_at),
    toUtcIso(review.received_at),
    review.elapsed_ms ?? null,
    JSON.stringify(review.state_before),
    JSON.stringify(review.state_after),
    JSON.stringify(review.review_log),
    review.fsrs_version,
    review.params_version,
    review.correction_of ?? null,
  ];
}

/**
 * 解答ログを 1 件入れる。review_id が冪等キーなので、同じ id の再送は何も変えずに false を返す
 * (訂正は上書きではなく correction_of を付けた別の行で入れる)。
 */
export async function insertReview(db: D1Database, review: NewReview): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO reviews (${COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (review_id) DO NOTHING`,
    )
    .bind(...reviewValues(review))
    .run();
  return result.meta.changes > 0;
}

/**
 * 評価を 1 回だけ確定する(設計書 §4 / Issue 3)。
 *
 * reviews の INSERT と card_state の条件付き UPDATE を 1 つの batch(= 1 トランザクション)で流す。
 * どちらの文も「読んだときの version(`expectedVersion`)がまだ生きている」ことを条件にしてあるので、
 * 先に別の評価が入っていた場合は 1 行も書かずに false を返す
 * (batch に包むだけでは「読んでから書くまでに割り込まれた」競合は防げないため、条件は SQL 側に置く)。
 *
 * UPDATE 側はさらに「この review_id のログがこのカードのものである」ことを条件にする。
 * 同じ review_id が別のカードに先に使われていた場合、INSERT は ON CONFLICT で飛ぶので
 * state だけが進んでしまう(= 同じ冪等キーで 2 枚動く)のを防ぐため。
 */
export async function commitReview(
  db: D1Database,
  params: {
    review: NewReview;
    /** 書き込む適用後の状態(version は expectedVersion + 1)。 */
    next: CardStateRow;
    /** 読み出したときの card_state.version。 */
    expectedVersion: number;
  },
): Promise<boolean> {
  const update = updateCardStateStatement(
    db,
    params.next,
    params.expectedVersion,
    params.review.review_id,
  );
  // INSERT を先に置く(UPDATE で version が進んだ後に条件を見ないように)。
  const insert = db
    .prepare(
      `INSERT INTO reviews (${COLUMNS})
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM card_state WHERE card_id = ? AND version = ?)
       ON CONFLICT (review_id) DO NOTHING`,
    )
    .bind(...reviewValues(params.review), params.next.card_id, params.expectedVersion);

  const [, updated] = await db.batch([insert, update]);
  return (updated?.meta.changes ?? 0) > 0;
}

/** 解答ログを 1 件取る(JSON 列は文字列のまま返す)。 */
export async function getReview(db: D1Database, reviewId: string): Promise<ReviewRow | null> {
  return await db
    .prepare(`SELECT ${COLUMNS} FROM reviews WHERE review_id = ?`)
    .bind(reviewId)
    .first<ReviewRow>();
}
