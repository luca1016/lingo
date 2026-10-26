import type { DueQueue } from "../../shared/review";
import { toUtcIso } from "../time";
import { DEFAULT_DECK_ID } from "./constants";

/** 出題候補 1 枚(cards と card_state を結合したもの)。 */
export interface DueCardRow {
  card_id: string;
  front: string;
  back: string;
  example: string | null;
  note: string | null;
  due: string;
  version: number;
  fsrs_state: number;
  reps: number;
  lapses: number;
}

const SELECT = `SELECT c.id AS card_id, c.front, c.back, c.example, c.note,
         s.due, s.version, s.fsrs_state, s.reps, s.lapses
       FROM card_state s JOIN cards c ON c.id = s.card_id
       WHERE c.deck_id = ? AND c.deleted_at IS NULL`;

// 待ち行列ごとの条件と並び順。
// 時刻は同じ書式の UTC ISO 8601 文字列なので、文字列の比較がそのまま時刻の比較になる。
const QUEUES: Record<DueQueue, { where: string; order: string; byDue: boolean }> = {
  // 学習中(Learning / Relearning)で期限が来たもの。短期再出題はここに戻ってくる。
  learning: {
    where: "s.fsrs_state IN (1, 3) AND s.due <= ?",
    order: "s.due ASC, c.id ASC",
    byDue: true,
  },
  // 復習(Review)で期限が来たもの。
  review: { where: "s.fsrs_state = 2 AND s.due <= ?", order: "s.due ASC, c.id ASC", byDue: true },
  // 新規(まだ 1 度も評価していない)。期限は見ず、1 日の上限で絞る。
  new: { where: "s.fsrs_state = 0", order: "c.created_at ASC, c.id ASC", byDue: false },
};

/** 待ち行列ごとに出題候補を取る(多いほうから limit 枚)。 */
export async function listDueCards(
  db: D1Database,
  params: { queue: DueQueue; now: Date; limit: number; deckId?: string },
): Promise<DueCardRow[]> {
  if (params.limit <= 0) return [];
  const queue = QUEUES[params.queue];
  const binds: unknown[] = [params.deckId ?? DEFAULT_DECK_ID];
  if (queue.byDue) binds.push(toUtcIso(params.now));

  const { results } = await db
    .prepare(`${SELECT} AND ${queue.where} ORDER BY ${queue.order} LIMIT ?`)
    .bind(...binds, params.limit)
    .all<DueCardRow>();
  return results;
}

/**
 * その範囲(`start` 以上 `end` 未満)に初回評価を確定したカードのユニーク枚数。
 * 1 枚のカードを何回評価しても 1 枚と数える(新規上限の消費量)。
 */
export async function countNewStartedBetween(
  db: D1Database,
  start: Date,
  end: Date,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT card_id, MIN(occurred_at) AS first_at FROM reviews GROUP BY card_id
       ) WHERE first_at >= ? AND first_at < ?`,
    )
    .bind(toUtcIso(start), toUtcIso(end))
    .first<{ n: number }>();
  return row?.n ?? 0;
}
