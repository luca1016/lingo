import { toUtcIso } from "../time";
import { DEFAULT_DECK_ID } from "./constants";

/** 統計に出す枚数(1 回の問い合わせでまとめて数える)。 */
export interface CardCounts {
  /** いま期限が来ている枚数。 */
  dueNow: number;
  /** その日の終わりまでに期限が来る枚数(`dueNow` を含む)。 */
  dueToday: number;
  /** 生きているカードの総数。 */
  total: number;
}

interface CountsRow {
  total: number | null;
  due_now: number | null;
  due_today: number | null;
}

/**
 * 「今 due」「今日中 due」「総数」を数える(論理削除したカードはどれにも入らない)。
 *
 * 期限で数えるのは学習中・復習・再学習(fsrs_state 1・2・3)だけ。新規(0)の `due` は
 * 作った時刻が入っているだけで予定ではないので、`nextDueAt` と同じく期限としては数えない
 *(新規は 1 日の上限で出る枚数が決まる。設計書 §1)。
 * 「今日中」は `dayEnd` 未満(= その日の終わりの瞬間は翌日ぶん)。
 */
export async function countCardStats(
  db: D1Database,
  params: { now: Date; dayEnd: Date; deckId?: string },
): Promise<CardCounts> {
  // bind は SQL に出てくる順(due_now の now → due_today の dayEnd → deck_id)。
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN s.fsrs_state IN (1, 2, 3) AND s.due <= ? THEN 1 ELSE 0 END) AS due_now,
              SUM(CASE WHEN s.fsrs_state IN (1, 2, 3) AND s.due <  ? THEN 1 ELSE 0 END) AS due_today
         FROM cards c LEFT JOIN card_state s ON s.card_id = c.id
        WHERE c.deck_id = ? AND c.deleted_at IS NULL`,
    )
    .bind(toUtcIso(params.now), toUtcIso(params.dayEnd), params.deckId ?? DEFAULT_DECK_ID)
    .first<CountsRow>();

  return {
    dueNow: row?.due_now ?? 0,
    dueToday: row?.due_today ?? 0,
    total: row?.total ?? 0,
  };
}

/**
 * 評価を確定した日("YYYY-MM-DD")を新しい順に返す(1 日に何回評価しても 1 つ)。
 *
 * 日付は `occurred_at`(端末が解答した時刻)で決める — 新規上限の「その日」
 *(`countNewStartedBetween`)と同じ基準。保存値は UTC なので、`offsetMinutes` だけずらしてから
 * カレンダー日にまとめる。ずれは「今」の分を全部の行に使うので、夏時間のある土地では古い日付が
 * 1 時間ずれ得る(設計上の timezone は Asia/Tokyo = ずれは一定。設計書 §1)。
 */
export async function listReviewDaysDesc(db: D1Database, offsetMinutes: number): Promise<string[]> {
  const modifier = `${offsetMinutes >= 0 ? "+" : ""}${offsetMinutes} minutes`;
  const { results } = await db
    .prepare(`SELECT DISTINCT date(occurred_at, ?) AS day FROM reviews ORDER BY day DESC`)
    .bind(modifier)
    .all<{ day: string | null }>();
  return results.map((row) => row.day).filter((day): day is string => day !== null);
}
