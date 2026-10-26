// D1 に入れる時刻は UTC の ISO 8601 文字列("YYYY-MM-DDTHH:MM:SS.sssZ")に統一する。
// Date <-> 文字列の変換はこのファイルの 2 つだけを使い、他の場所では書かない
//(JST はカレンダー上の「今日」の境界計算にだけ使う。保存値には出てこない)。

/** Date を保存用の UTC ISO 8601 文字列にする。 */
export function toUtcIso(date: Date): string {
  const ms = date.getTime();
  if (Number.isNaN(ms)) throw new RangeError("invalid date");
  return new Date(ms).toISOString();
}

/** 保存されている UTC ISO 8601 文字列を Date に戻す。 */
export function fromUtcIso(value: string): Date {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new RangeError(`invalid timestamp: ${value}`);
  return new Date(ms);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** `at` の瞬間における `timeZone` の UTC からのずれ(ms)。 */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const field = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  const wall = Date.UTC(
    field("year"),
    field("month") - 1,
    field("day"),
    // 0 時を "24" と書く実装があるので丸める。
    field("hour") % 24,
    field("minute"),
    field("second"),
  );
  if (Number.isNaN(wall)) throw new RangeError(`invalid time zone or date: ${timeZone}`);
  // Intl はミリ秒を返さないので、比べる側も秒に落としてから差を取る。
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

/** その瞬間を含むカレンダー日の 0 時(その土地の壁時計)を UTC の瞬間で返す。 */
function startOfZonedDay(at: Date, timeZone: string): Date {
  const offset = zoneOffsetMs(at, timeZone);
  const wall = at.getTime() + offset;
  return new Date(Math.floor(wall / DAY_MS) * DAY_MS - offset);
}

/**
 * その土地の「今日」の範囲を UTC の瞬間で返す(`start` 以上 `end` 未満)。
 * 新規上限のように日付の境界で区切る計算だけに使う(保存値は UTC のまま。設計書 §1)。
 */
export function dayWindow(now: Date, timeZone: string): { start: Date; end: Date } {
  const start = startOfZonedDay(now, timeZone);
  // 翌日の正午から求め直す(夏時間のある土地でも 1 日の長さを 24 時間と決めつけない)。
  const end = startOfZonedDay(new Date(start.getTime() + DAY_MS + DAY_MS / 2), timeZone);
  return { start, end };
}
