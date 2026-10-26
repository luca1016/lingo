// カード取り込みの契約(設計書 §4 / Issue 2)。
// 上限と行の検証はここだけに書き、Worker(POST /api/cards)と画面のプレビューの両方が同じ規則を使う
//(画面で OK に見えた行がサーバで弾かれる、の逆を作らないため)。
// このファイルは純粋な TypeScript で、D1 も DOM も触らない。

/** 1 回の取り込みで受け付けるカードの上限。 */
export const MAX_CARDS_PER_IMPORT = 500;

/** import_id(端末が採番する UUID)の長さの上限。 */
export const MAX_IMPORT_ID_LENGTH = 64;

/** 各フィールドの文字数上限(コードポイント数で数える)。 */
export const FIELD_LIMITS = {
  front: 128,
  back: 256,
  example: 512,
  note: 512,
} as const;

/** リクエスト本文のサイズ上限(バイト)。これを超えたら中身を見ずに 413 で返す。 */
export const MAX_BODY_BYTES = 1024 * 1024;

export type CardField = keyof typeof FIELD_LIMITS;

/** 端末から来る 1 行(JSON / parser の出力。どの値も未検証)。 */
export interface CardInput {
  front?: unknown;
  back?: unknown;
  example?: unknown;
  note?: unknown;
}

/** 検証を通した 1 行(前後の空白は落とし、空の任意項目は null にしてある)。 */
export interface NormalizedCard {
  front: string;
  back: string;
  example: string | null;
  note: string | null;
}

export type RowErrorCode = "not_an_object" | "required" | "not_a_string" | "too_long";

/** どの行のどのフィールドがなぜ無効かを表す。応答にも画面のプレビューにもこれを出す。 */
export interface RowError {
  /** 1 始まりの行番号(cards 配列の位置)。 */
  row: number;
  /** 行全体の問題なら null。 */
  field: CardField | null;
  code: RowErrorCode;
  /** 画面にそのまま出せる日本語の説明。 */
  message: string;
}

const FIELD_LABELS: Record<CardField, string> = {
  front: "表(front)",
  back: "裏(back)",
  example: "例文(example)",
  note: "メモ(note)",
};

/** 文字数はコードポイントで数える(絵文字や結合文字で上限が揺れないように)。 */
export function countChars(value: string): number {
  return [...value].length;
}

function error(
  row: number,
  field: CardField | null,
  code: RowErrorCode,
  message: string,
): RowError {
  return { row, field, code, message };
}

function requiredField(
  value: unknown,
  field: "front" | "back",
  row: number,
): { value?: string; errors: RowError[] } {
  if (value === undefined || value === null || value === "") {
    return { errors: [error(row, field, "required", `${FIELD_LABELS[field]}は必須です`)] };
  }
  if (typeof value !== "string") {
    return { errors: [error(row, field, "not_a_string", `${FIELD_LABELS[field]}は文字列で送る`)] };
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return { errors: [error(row, field, "required", `${FIELD_LABELS[field]}は必須です`)] };
  }
  if (countChars(trimmed) > FIELD_LIMITS[field]) {
    return {
      errors: [
        error(
          row,
          field,
          "too_long",
          `${FIELD_LABELS[field]}は ${FIELD_LIMITS[field]} 文字以内(${countChars(trimmed)} 文字)`,
        ),
      ],
    };
  }
  return { value: trimmed, errors: [] };
}

function optionalField(
  value: unknown,
  field: "example" | "note",
  row: number,
): { value: string | null; errors: RowError[] } {
  if (value === undefined || value === null || value === "") return { value: null, errors: [] };
  if (typeof value !== "string") {
    return {
      value: null,
      errors: [error(row, field, "not_a_string", `${FIELD_LABELS[field]}は文字列で送る`)],
    };
  }
  const trimmed = value.trim();
  if (trimmed === "") return { value: null, errors: [] };
  if (countChars(trimmed) > FIELD_LIMITS[field]) {
    return {
      value: null,
      errors: [
        error(
          row,
          field,
          "too_long",
          `${FIELD_LABELS[field]}は ${FIELD_LIMITS[field]} 文字以内(${countChars(trimmed)} 文字)`,
        ),
      ],
    };
  }
  return { value: trimmed, errors: [] };
}

/** 1 行を検証して正規化する。無効なら card は無く、理由が errors に入る。 */
export function normalizeRow(
  value: unknown,
  row: number,
): { card?: NormalizedCard; errors: RowError[] } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { errors: [error(row, null, "not_an_object", "行はオブジェクトで送る")] };
  }
  const input = value as CardInput;
  const front = requiredField(input.front, "front", row);
  const back = requiredField(input.back, "back", row);
  const example = optionalField(input.example, "example", row);
  const note = optionalField(input.note, "note", row);

  const errors = [...front.errors, ...back.errors, ...example.errors, ...note.errors];
  if (errors.length > 0 || front.value === undefined || back.value === undefined) return { errors };
  return {
    card: { front: front.value, back: back.value, example: example.value, note: note.value },
    errors: [],
  };
}

/**
 * 全行を検証する(1 行でも無効なら呼び出し側は何も変更しない)。
 * cards は有効だった行だけ、errors は無効だった行の理由すべて。
 */
export function normalizeRows(rows: readonly unknown[]): {
  cards: NormalizedCard[];
  errors: RowError[];
} {
  const cards: NormalizedCard[] = [];
  const errors: RowError[] = [];
  for (const [index, value] of rows.entries()) {
    const result = normalizeRow(value, index + 1);
    if (result.card) cards.push(result.card);
    errors.push(...result.errors);
  }
  return { cards, errors };
}

// ---- 応答の形(POST /api/cards)----

/** 1 行の取り込み結果。added で「追加したか / しなかったか」を明示する。 */
export interface ImportRowResult {
  /** 1 始まりの行番号(cards 配列の位置)。 */
  row: number;
  front: string;
  added: boolean;
  /** 追加したカードの id(added が false なら無い)。 */
  card_id?: string;
  /** 追加しなかった理由(重複は上書きしない)。 */
  warning?: "duplicate_front";
  /** 重複先の既存カードの id。 */
  existing_card_id?: string;
}

/** 取り込み成功時の応答本文。再送には 1 回目とまったく同じものを返す。 */
export interface ImportResponse {
  import_id: string;
  /** 追加したカード数。 */
  added: number;
  /** 重複で追加しなかったカード数。 */
  skipped: number;
  /** 行ごとの結果(リクエストと同じ順序)。 */
  results: ImportRowResult[];
}

export type ImportErrorCode =
  | "invalid_json"
  | "invalid_import_id"
  | "invalid_cards"
  | "no_cards"
  | "too_many_cards"
  | "payload_too_large";

/** 取り込み失敗時の応答本文(4xx)。何も変更していない。 */
export interface ImportErrorResponse {
  error: ImportErrorCode;
  message: string;
  /** invalid_cards のときだけ、どの行がなぜ無効かが入る。 */
  errors?: RowError[];
  /** too_many_cards / payload_too_large のときの上限と実測値。 */
  limit?: number;
  count?: number;
}
