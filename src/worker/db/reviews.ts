import { toUtcIso } from "../time";
import type { NewReview, ReviewRow } from "./types";

const COLUMNS =
  "review_id, card_id, rating, occurred_at, received_at, state_before, state_after, review_log, fsrs_version, params_version, correction_of";

/**
 * 解答ログを 1 件入れる。review_id が冪等キーなので、同じ id の再送は何も変えずに false を返す
 * (訂正は上書きではなく correction_of を付けた別の行で入れる)。
 */
export async function insertReview(db: D1Database, review: NewReview): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO reviews (${COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (review_id) DO NOTHING`,
    )
    .bind(
      review.review_id,
      review.card_id,
      review.rating,
      toUtcIso(review.occurred_at),
      toUtcIso(review.received_at),
      JSON.stringify(review.state_before),
      JSON.stringify(review.state_after),
      JSON.stringify(review.review_log),
      review.fsrs_version,
      review.params_version,
      review.correction_of ?? null,
    )
    .run();
  return result.meta.changes > 0;
}

/** 解答ログを 1 件取る(JSON 列は文字列のまま返す)。 */
export async function getReview(db: D1Database, reviewId: string): Promise<ReviewRow | null> {
  return await db
    .prepare(`SELECT ${COLUMNS} FROM reviews WHERE review_id = ?`)
    .bind(reviewId)
    .first<ReviewRow>();
}
