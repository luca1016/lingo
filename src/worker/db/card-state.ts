import type { CardStateRow } from "./types";

const COLUMNS =
  "card_id, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review, version, updated_at";

/** カードの FSRS 状態を取る。まだ 1 度も解答していなければ null。 */
export async function getCardState(db: D1Database, cardId: string): Promise<CardStateRow | null> {
  return await db
    .prepare(`SELECT ${COLUMNS} FROM card_state WHERE card_id = ?`)
    .bind(cardId)
    .first<CardStateRow>();
}

/**
 * FSRS 状態を楽観ロックで書く。
 * `expectedVersion` は読み出したときの version(行が無ければ 0)。`next.version` はその +1 でなければならない。
 * 他の更新が先に入っていた(= version が合わない)ときは何も書かずに false を返す。
 */
export async function saveCardState(
  db: D1Database,
  next: CardStateRow,
  expectedVersion: number,
): Promise<boolean> {
  if (next.version !== expectedVersion + 1) {
    throw new Error(`version mismatch: expected ${expectedVersion + 1}, got ${next.version}`);
  }

  if (expectedVersion === 0) {
    // 初回。並行して先に入っていたら ON CONFLICT で何も起きない。
    const inserted = await db
      .prepare(
        `INSERT INTO card_state (${COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (card_id) DO NOTHING`,
      )
      .bind(
        next.card_id,
        next.due,
        next.stability,
        next.difficulty,
        next.elapsed_days,
        next.scheduled_days,
        next.learning_steps,
        next.reps,
        next.lapses,
        next.state,
        next.last_review,
        next.version,
        next.updated_at,
      )
      .run();
    return inserted.meta.changes > 0;
  }

  const updated = await db
    .prepare(
      `UPDATE card_state
       SET due = ?, stability = ?, difficulty = ?, elapsed_days = ?, scheduled_days = ?,
           learning_steps = ?, reps = ?, lapses = ?, state = ?, last_review = ?,
           version = ?, updated_at = ?
       WHERE card_id = ? AND version = ?`,
    )
    .bind(
      next.due,
      next.stability,
      next.difficulty,
      next.elapsed_days,
      next.scheduled_days,
      next.learning_steps,
      next.reps,
      next.lapses,
      next.state,
      next.last_review,
      next.version,
      next.updated_at,
      next.card_id,
      expectedVersion,
    )
    .run();
  return updated.meta.changes > 0;
}
