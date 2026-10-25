import type { FSRSParameters, ReviewLog } from "ts-fsrs";

// 行の型は D1 の列をそのまま写す(時刻は UTC ISO 8601 文字列、JSON 列は文字列)。
// Date やオブジェクトへの変換は各関数の境界で行う。

/** decks の 1 行。 */
export interface DeckRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

/** cards の 1 行。deleted_at が入っていれば論理削除済み。 */
export interface CardRow {
  id: string;
  deck_id: string;
  term: string;
  meaning: string;
  example: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** card_state の 1 行(ts-fsrs の Card + 楽観ロックの version)。 */
export interface CardStateRow {
  card_id: string;
  due: string;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  state: number;
  last_review: string | null;
  version: number;
  updated_at: string;
}

/** reviews の 1 行(JSON 列は文字列のまま)。 */
export interface ReviewRow {
  review_id: string;
  card_id: string;
  rating: number;
  occurred_at: string;
  received_at: string;
  state_before: string;
  state_after: string;
  review_log: string;
  fsrs_version: string;
  params_version: number;
  correction_of: string | null;
}

/** reviews へ入れる値。JSON と時刻はこの層で文字列にする。 */
export interface NewReview {
  review_id: string;
  card_id: string;
  rating: number;
  occurred_at: Date;
  received_at: Date;
  state_before: CardStateRow;
  state_after: CardStateRow;
  review_log: ReviewLog;
  fsrs_version: string;
  params_version: number;
  /** 訂正のときだけ、訂正元の review_id を入れる。 */
  correction_of?: string | null;
}

/** settings(1 行)を使いやすい形にしたもの。 */
export interface Settings {
  /** 「今日」の境界計算に使う IANA タイムゾーン。 */
  timezone: string;
  /** 1 日に出す新規カードの上限。 */
  newCardsPerDay: number;
  /** ts-fsrs にそのまま渡せるパラメータ。 */
  fsrs: FSRSParameters;
  /** パラメータの版(reviews.params_version に記録する)。 */
  paramsVersion: number;
  updatedAt: Date;
}
