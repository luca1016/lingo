import { toUtcIso } from "../time";
import { updateCardStateStatement } from "./card-state";
import type { CardStateRow, NewReview, ReviewRow } from "./types";

const COLUMNS =
  "review_id, card_id, rating, version_before, occurred_at, received_at, elapsed_ms, state_before, state_after, review_log, fsrs_version, params_version, correction_of";

/** insertReview / commitReview が bind する値(COLUMNS と同じ順)。 */
function reviewValues(review: NewReview): unknown[] {
  return [
    review.review_id,
    review.card_id,
    review.rating,
    // 適用前の version。state_before と食い違わないように、そこから取る。
    review.state_before.version,
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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
 * batch に包むだけでは「読んでから書くまでに割り込まれた」競合は防げないので、条件はすべて SQL 側に置く。
 *
 * - INSERT は `ON CONFLICT (review_id) DO NOTHING`(冪等キー)。さらに「読んだときの version
 *   (`expectedVersion`)がまだ生きている」ことも条件にする(割り込まれていればログも書かない)。
 * - UPDATE は「version が `expectedVersion` のまま」かつ「この review_id・この card_id・この
 *   version_before のログがある」ことを条件にする。
 *
 * この組み合わせだと、INSERT が冪等キーの衝突で無視された場合(= 同じ review_id が先に使われていた)
 * は UPDATE の EXISTS も成り立たないので 0 件になる。つまり「ログ 1 行と state 1 回分」は
 * どちらも入るかどちらも入らないかのどちらかで、同じ冪等キーで state が 2 回進むことがない。
 * 1 行も書かなかったときは false を返す(200 を返してよいか 409 かは呼び出し側が判断する)。
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
  if (params.review.state_before.version !== params.expectedVersion) {
    throw new Error(
      `state_before.version mismatch: expected ${params.expectedVersion}, got ${params.review.state_before.version}`,
    );
  }
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
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
