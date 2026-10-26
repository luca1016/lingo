import type { Handler } from "hono";
import { createEmptyCard } from "ts-fsrs";
import {
  type ImportErrorCode,
  type ImportErrorResponse,
  type ImportResponse,
  type ImportRowResult,
  MAX_BODY_BYTES,
  MAX_CARDS_PER_IMPORT,
  MAX_IMPORT_ID_LENGTH,
  type NormalizedCard,
  normalizeRows,
  type RowError,
} from "../shared/cards";
import type { AccessVariables } from "./access";
import { findCardIdsByFront, getImport, insertImport, type NewImportedCard } from "./db";
import { toCardStateRow } from "./fsrs";

type AppEnv = { Bindings: Env; Variables: AccessVariables };

/** 4xx はすべてこの形(何も変更していない)。 */
function failure(
  error: ImportErrorCode,
  message: string,
  extra: Partial<ImportErrorResponse> = {},
): ImportErrorResponse {
  return { error, message, ...extra };
}

/**
 * POST /api/cards — カードの取り込み。
 *
 * - `import_id` で冪等。同じ `import_id` の再送には 1 回目の応答本文をそのまま返し、カードを増やさない
 *   (2 回目の中身が違っていても 1 回目の結果が正。先に書いたほうが勝つ)。
 * - 全行を先に検証し、1 行でも無効なら D1 を一切変えずに 400 で理由を返す。
 * - 既存と同じ `front` は上書きせず、その行を追加しないで警告だけ返す(`added: false`)。
 * - 追加するカードには「新規」の `card_state` を同じトランザクションで作る。
 */
export const postCards: Handler<AppEnv> = async (c) => {
  // 1) 本文サイズ。宣言された長さで弾けるならそこで止め、無ければ実測で見る。
  const declared = Number(c.req.header("Content-Length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return c.json(tooLarge(declared), 413);
  }
  const raw = await c.req.text();
  const size = new TextEncoder().encode(raw).byteLength;
  if (size > MAX_BODY_BYTES) return c.json(tooLarge(size), 413);

  // 2) JSON として読む。
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return c.json(failure("invalid_json", "本文が JSON ではない"), 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return c.json(failure("invalid_json", "本文は JSON オブジェクトで送る"), 400);
  }

  // 3) 冪等キーとカード配列の形。
  const { import_id: importId, cards } = body as { import_id?: unknown; cards?: unknown };
  if (
    typeof importId !== "string" ||
    importId.trim() === "" ||
    importId.length > MAX_IMPORT_ID_LENGTH
  ) {
    return c.json(
      failure("invalid_import_id", `import_id は 1〜${MAX_IMPORT_ID_LENGTH} 文字の文字列で送る`, {
        limit: MAX_IMPORT_ID_LENGTH,
      }),
      400,
    );
  }
  if (!Array.isArray(cards)) {
    return c.json(failure("invalid_cards", "cards は配列で送る"), 400);
  }
  if (cards.length === 0) {
    return c.json(failure("no_cards", "cards が空"), 400);
  }
  if (cards.length > MAX_CARDS_PER_IMPORT) {
    return c.json(
      failure("too_many_cards", `1 回に取り込めるのは ${MAX_CARDS_PER_IMPORT} 件まで`, {
        limit: MAX_CARDS_PER_IMPORT,
        count: cards.length,
      }),
      400,
    );
  }

  // 4) 全行の検証。1 行でも無効ならここで終わり(D1 には触っていない)。
  const { cards: normalized, errors } = normalizeRows(cards);
  if (errors.length > 0) return c.json(invalidRows(errors), 400);

  // 5) 再送なら 1 回目の応答をそのまま返す。
  const replayed = await getImport(c.env.DB, importId);
  if (replayed) return c.json(JSON.parse(replayed.result) as ImportResponse, 200);

  const response = await importCards(c.env.DB, importId, normalized, new Date());
  return c.json(response, 200);
};

function tooLarge(size: number): ImportErrorResponse {
  return failure("payload_too_large", `本文は ${MAX_BODY_BYTES} バイト以内`, {
    limit: MAX_BODY_BYTES,
    count: size,
  });
}

function invalidRows(errors: RowError[]): ImportErrorResponse {
  return failure("invalid_cards", `無効な行が ${new Set(errors.map((e) => e.row)).size} 行ある`, {
    errors,
  });
}

/** 重複を除いたカードを採番して書き、応答本文を作る。 */
async function importCards(
  db: D1Database,
  importId: string,
  rows: readonly NormalizedCard[],
  now: Date,
): Promise<ImportResponse> {
  const existing = await findCardIdsByFront(
    db,
    rows.map((row) => row.front),
  );

  const results: ImportRowResult[] = [];
  const toInsert: NewImportedCard[] = [];
  // 同じリクエストの中で front が重なった場合も、最初の 1 行だけを追加する。
  const addedFronts = new Map<string, string>();

  for (const [index, row] of rows.entries()) {
    const duplicate = existing.get(row.front) ?? addedFronts.get(row.front);
    if (duplicate) {
      results.push({
        row: index + 1,
        front: row.front,
        added: false,
        warning: "duplicate_front",
        existing_card_id: duplicate,
      });
      continue;
    }
    const id = crypto.randomUUID();
    toInsert.push({
      id,
      front: row.front,
      back: row.back,
      example: row.example,
      note: row.note,
      // 新規カードの FSRS 状態(未解答。version は 1 から)。
      state: toCardStateRow(id, createEmptyCard(now), 1, now),
    });
    addedFronts.set(row.front, id);
    results.push({ row: index + 1, front: row.front, added: true, card_id: id });
  }

  const response: ImportResponse = {
    import_id: importId,
    added: toInsert.length,
    skipped: results.length - toInsert.length,
    results,
  };

  try {
    await insertImport(db, { importId, receivedAt: now, result: response, cards: toInsert });
  } catch (cause) {
    // 同じ import_id が並行して先に入った場合(主キー衝突)。batch なので 1 行も入っていない。
    const stored = await getImport(db, importId);
    if (!stored) throw cause;
    return JSON.parse(stored.result) as ImportResponse;
  }
  return response;
}
