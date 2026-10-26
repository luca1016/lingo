// 貼り付け取り込みの parser(Issue 2)。依存は増やさず自前で書く。
// 対応: TSV / CSV(ヘッダ付き・無し)、引用符内のカンマと改行、"" による引用符のエスケープ、CRLF・CR、先頭の BOM。
// 改行は LF にそろえる(引用符内の CRLF も \n として項目に残す)。
// ここは「文字列を行と列に割る」だけで、値の検証は src/shared/cards.ts が行う。

import type { CardInput } from "../shared/cards";

/** 区切り文字。タブがあれば TSV、無ければ CSV とみなす。 */
export type Delimiter = "," | "\t";

const BOM = "﻿";

export interface ParseResult {
  delimiter: Delimiter;
  /** ヘッダ行と判断した場合はその中身、していなければ null。 */
  header: string[] | null;
  /** 取り込み候補の行(前後の空白や空項目の扱いは検証側に任せる)。 */
  rows: CardInput[];
}

/** 先頭の BOM(U+FEFF)を落とす。 */
export function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(1) : text;
}

/** 引用符の外にあるタブとカンマを数えて区切り文字を決める。 */
export function detectDelimiter(text: string): Delimiter {
  let inQuotes = false;
  let tabs = 0;
  let commas = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === '"') {
      if (inQuotes && text.charAt(i + 1) === '"') {
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (ch === "\t") tabs++;
    else if (ch === ",") commas++;
  }
  return tabs > 0 && tabs >= commas ? "\t" : ",";
}

/**
 * 区切り文字で表に割る(RFC 4180 に寄せた最小実装)。
 * 引用符は項目の先頭にあるときだけ引用の開始として扱い、中の `""` は引用符 1 つ、改行とカンマは項目の一部にする。
 */
export function parseDelimited(text: string, delimiter: Delimiter): string[][] {
  const src = stripBom(text);
  const table: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let inQuotes = false;

  const endField = () => {
    row.push(field);
    field = "";
    quoted = false;
  };
  const endRow = () => {
    endField();
    table.push(row);
    row = [];
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src.charAt(i);
    if (inQuotes) {
      if (ch === '"') {
        if (src.charAt(i + 1) === '"') {
          field += '"';
          i++;
          continue;
        }
        inQuotes = false;
        continue;
      }
      // 引用符の中の改行は項目の一部。CRLF・CR は LF にそろえる(保存する値に \r を残さない)。
      if (ch === "\r") {
        if (src.charAt(i + 1) === "\n") i++;
        field += "\n";
        continue;
      }
      field += ch;
      continue;
    }
    if (ch === '"' && field === "" && !quoted) {
      inQuotes = true;
      quoted = true;
      continue;
    }
    if (ch === delimiter) {
      endField();
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      // CRLF は 1 つの改行として扱う。
      if (ch === "\r" && src.charAt(i + 1) === "\n") i++;
      endRow();
      continue;
    }
    field += ch;
  }
  // 末尾に改行が無い場合の最後の行(改行だけで終わっていれば何も足さない)。
  if (field !== "" || quoted || row.length > 0) endRow();

  return table;
}

/** ヘッダ名 -> カードのフィールド。日本語の見出しも受ける。 */
const HEADER_ALIASES = new Map<string, keyof CardInput>([
  ["front", "front"],
  ["word", "front"],
  ["term", "front"],
  ["表", "front"],
  ["単語", "front"],
  ["back", "back"],
  ["meaning", "back"],
  ["translation", "back"],
  ["裏", "back"],
  ["意味", "back"],
  ["訳", "back"],
  ["example", "example"],
  ["sentence", "example"],
  ["例文", "example"],
  ["例", "example"],
  ["note", "note"],
  ["memo", "note"],
  ["メモ", "note"],
  ["備考", "note"],
]);

/** 1 行目がヘッダなら列の対応を返す(front と back の両方が見つかったときだけヘッダとみなす)。 */
export function headerColumns(cells: readonly string[]): Map<keyof CardInput, number> | null {
  const columns = new Map<keyof CardInput, number>();
  for (const [index, cell] of cells.entries()) {
    const field = HEADER_ALIASES.get(stripBom(cell).trim().toLowerCase());
    if (field && !columns.has(field)) columns.set(field, index);
  }
  return columns.has("front") && columns.has("back") ? columns : null;
}

const POSITIONAL = new Map<keyof CardInput, number>([
  ["front", 0],
  ["back", 1],
  ["example", 2],
  ["note", 3],
]);

/** 貼り付けられた文字列をカードの行にする。空行は読み飛ばす。 */
export function parseCards(text: string): ParseResult {
  const src = stripBom(text);
  const delimiter = detectDelimiter(src);
  const table = parseDelimited(src, delimiter).filter((cells) =>
    cells.some((cell) => cell.trim() !== ""),
  );
  if (table.length === 0) return { delimiter, header: null, rows: [] };

  const first = table[0] ?? [];
  const columns = headerColumns(first);
  const body = columns ? table.slice(1) : table;
  const order = columns ?? POSITIONAL;

  const cell = (cells: string[], field: keyof CardInput): string => {
    const index = order.get(field);
    return index === undefined ? "" : (cells[index] ?? "");
  };

  return {
    delimiter,
    header: columns ? first : null,
    rows: body.map((cells) => ({
      front: cell(cells, "front"),
      back: cell(cells, "back"),
      example: cell(cells, "example"),
      note: cell(cells, "note"),
    })),
  };
}
