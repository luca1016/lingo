// 貼り付け取り込みのプレビュー(行ごとの検証結果)。画面から切り離して単体テストできるようにしてある。

import {
  MAX_CARDS_PER_IMPORT,
  type NormalizedCard,
  normalizeRows,
  type RowError,
} from "../shared/cards";
import { parseCards } from "./parse";

export interface Preview {
  /** 送れる行(検証を通ったもの)。 */
  cards: NormalizedCard[];
  /** 無効な行の理由すべて。1 つでもあれば取り込まない。 */
  errors: RowError[];
  /** 行ごとの表示(検証結果つき)。 */
  rows: { row: number; front: string; back: string; errors: RowError[] }[];
  /** 画面に出す区切り文字の名前。 */
  delimiter: string;
  /** ヘッダ行と判断した場合はその中身。 */
  header: string[] | null;
  tooMany: boolean;
}

export function buildPreview(text: string): Preview {
  const parsed = parseCards(text);
  const { cards, errors } = normalizeRows(parsed.rows);
  return {
    cards,
    errors,
    rows: parsed.rows.map((r, index) => ({
      row: index + 1,
      front: String(r.front ?? ""),
      back: String(r.back ?? ""),
      errors: errors.filter((e) => e.row === index + 1),
    })),
    delimiter: parsed.delimiter === "\t" ? "TSV(タブ区切り)" : "CSV(カンマ区切り)",
    header: parsed.header,
    tooMany: parsed.rows.length > MAX_CARDS_PER_IMPORT,
  };
}

/** そのプレビューをそのまま取り込めるか(無効行なし・上限内・1 件以上)。 */
export function canImport(preview: Preview): boolean {
  return preview.errors.length === 0 && !preview.tooMany && preview.cards.length > 0;
}
