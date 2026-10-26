import {
  type Card,
  type FSRSParameters,
  FSRSVersion,
  fixState,
  fsrs,
  type Grade,
  Rating,
  type ReviewLog,
} from "ts-fsrs";
import type { ReviewRating, ReviewState } from "../shared/review";
import type { CardStateRow } from "./db/types";
import { fromUtcIso, toUtcIso } from "./time";

/**
 * ts-fsrs の Card を card_state の行にする。
 * `version` は楽観ロックの新しい版(初回は 1)、`updatedAt` は書いた時刻。
 */
export function toCardStateRow(
  cardId: string,
  card: Card,
  version: number,
  updatedAt: Date,
): CardStateRow {
  return {
    card_id: cardId,
    due: toUtcIso(card.due),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    fsrs_state: card.state,
    last_review: card.last_review ? toUtcIso(card.last_review) : null,
    version,
    updated_at: toUtcIso(updatedAt),
  };
}

/** card_state の行を ts-fsrs の Card に戻す(toCardStateRow の逆)。 */
export function toFsrsCard(row: CardStateRow): Card {
  return {
    due: fromUtcIso(row.due),
    stability: row.stability,
    difficulty: row.difficulty,
    elapsed_days: row.elapsed_days,
    scheduled_days: row.scheduled_days,
    learning_steps: row.learning_steps,
    reps: row.reps,
    lapses: row.lapses,
    state: fixState(row.fsrs_state),
    last_review: row.last_review ? fromUtcIso(row.last_review) : undefined,
  };
}

/** 端末が送る rating(1〜4)と ts-fsrs の Grade の対応。0=Manual は受け取らない。 */
const GRADES: Record<ReviewRating, Grade> = {
  1: Rating.Again,
  2: Rating.Hard,
  3: Rating.Good,
  4: Rating.Easy,
};

/** 1 回の評価を適用した結果(reviews に書く材料がそろっている)。 */
export interface AppliedReview {
  /** 適用前の行(そのまま)。 */
  state_before: CardStateRow;
  /** 適用後の行(version は +1、updated_at は `receivedAt`)。 */
  state_after: CardStateRow;
  /** ts-fsrs の ReviewLog(加工しない)。 */
  review_log: ReviewLog;
  /** 計算に使った ts-fsrs の版。 */
  fsrs_version: string;
}

/**
 * 1 回の評価を適用して次の状態を求める純関数(HTTP も D1 も触らない)。
 * 短期再出題(学習ステップ / 再学習ステップ)は `parameters` の learning_steps・relearning_steps
 * がそのまま効く(settings の値。既定は `1m 10m`)。
 */
export function applyReview(params: {
  /** 現在の card_state(読み出した行)。 */
  state: CardStateRow;
  rating: ReviewRating;
  /** 端末が解答した時刻。FSRS の基準時刻はこれ。 */
  occurredAt: Date;
  /** サーバが受け取った時刻。行の updated_at に入る。 */
  receivedAt: Date;
  /** settings の FSRS パラメータ。 */
  parameters: FSRSParameters;
}): AppliedReview {
  const { state, rating, occurredAt, receivedAt, parameters } = params;
  const { card, log } = fsrs(parameters).next(toFsrsCard(state), occurredAt, GRADES[rating]);
  return {
    state_before: state,
    state_after: toCardStateRow(state.card_id, card, state.version + 1, receivedAt),
    review_log: log,
    fsrs_version: FSRSVersion,
  };
}

/** card_state の行から、応答に出す形(必要な分だけ)を作る。 */
export function toReviewState(row: CardStateRow): ReviewState {
  return {
    due: row.due,
    version: row.version,
    fsrs_state: row.fsrs_state,
    reps: row.reps,
    lapses: row.lapses,
    scheduled_days: row.scheduled_days,
    last_review: row.last_review,
  };
}
