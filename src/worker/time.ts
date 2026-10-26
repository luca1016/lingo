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
