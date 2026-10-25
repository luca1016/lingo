import { type Card, fixState } from "ts-fsrs";
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
    state: card.state,
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
    state: fixState(row.state),
    last_review: row.last_review ? fromUtcIso(row.last_review) : undefined,
  };
}
