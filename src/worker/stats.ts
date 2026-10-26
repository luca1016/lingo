import type { Handler } from "hono";
import type { StatsResponse } from "../shared/stats";
import type { AccessVariables } from "./access";
import { countCardStats, getSettings, listReviewDaysDesc } from "./db";
import { dayWindow, previousDateKey, toUtcIso, zoneDateKey, zoneOffsetMinutes } from "./time";

type AppEnv = { Bindings: Env; Variables: AccessVariables };

/**
 * 連続日数(純粋)。評価を確定した日の集合を、今日から 1 日ずつ前へたどって数える。
 *
 * 今日まだ評価していなければ前日から数える(日の途中で 0 に落とさない。今日評価すれば
 * そのまま 1 つ増える)。今日も前日も無ければ 0。
 */
export function streakFrom(days: ReadonlySet<string>, todayKey: string): number {
  let cursor = days.has(todayKey) ? todayKey : previousDateKey(todayKey);
  let streak = 0;
  while (days.has(cursor)) {
    streak += 1;
    cursor = previousDateKey(cursor);
  }
  return streak;
}

/**
 * GET /api/stats — 4 つの数字。
 *
 * - `due_now` いま期限が来ている枚数(学習中・復習。新規は期限を持たないので数えない)
 * - `due_today` その日の終わり(timezone の当日末)までに期限が来る枚数(`due_now` を含む)
 * - `total` 生きているカードの総数(論理削除を除く)
 * - `streak_days` 評価を確定した日(timezone の日付)の連続日数
 *
 * 「その日」の境界は settings の timezone(既定 Asia/Tokyo)で決める。保存値は UTC のまま。
 */
export const getStats: Handler<AppEnv> = async (c) => {
  const now = new Date();
  const settings = await getSettings(c.env.DB);
  const today = dayWindow(now, settings.timezone);

  const counts = await countCardStats(c.env.DB, { now, dayEnd: today.end });
  const days = await listReviewDaysDesc(c.env.DB, zoneOffsetMinutes(now, settings.timezone));

  const response: StatsResponse = {
    now: toUtcIso(now),
    due_now: counts.dueNow,
    due_today: counts.dueToday,
    total: counts.total,
    streak_days: streakFrom(new Set(days), zoneDateKey(now, settings.timezone)),
  };
  return c.json(response);
};
