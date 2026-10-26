// 統計の契約(設計書 §1・§5 / Issue 5)。GET /api/stats の応答の形をここだけに書く
// (Worker と画面が同じ形を見る)。このファイルは純粋な TypeScript で、D1 も DOM も触らない。

/** GET /api/stats の応答(4 つの数字と、サーバが見た現在時刻)。 */
export interface StatsResponse {
  /** サーバが見た現在時刻(UTC)。 */
  now: string;
  /** いま期限が来ている枚数(学習中・復習。新規は期限を持たないので数えない)。 */
  due_now: number;
  /** その日(settings の timezone)の終わりまでに期限が来る枚数(`due_now` を含む)。 */
  due_today: number;
  /** 生きているカードの総数(論理削除を除く)。 */
  total: number;
  /** 評価を確定した日(timezone の日付)の連続日数。今日まだなら前日までの連続。 */
  streak_days: number;
}
