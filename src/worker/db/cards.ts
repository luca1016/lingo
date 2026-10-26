import { DEFAULT_DECK_ID } from "./constants";
import type { CardRow, DeckRow } from "./types";

const CARD_COLUMNS = "id, deck_id, front, back, example, note, created_at, updated_at, deleted_at";

/** カードを 1 枚取る。存在しない・論理削除済みなら null。 */
export async function getCard(db: D1Database, id: string): Promise<CardRow | null> {
  return await db
    .prepare(`SELECT ${CARD_COLUMNS} FROM cards WHERE id = ? AND deleted_at IS NULL`)
    .bind(id)
    .first<CardRow>();
}

/** 論理削除も含めてカードを 1 枚取る(訂正や import の重複判定用)。 */
export async function getCardIncludingDeleted(db: D1Database, id: string): Promise<CardRow | null> {
  return await db
    .prepare(`SELECT ${CARD_COLUMNS} FROM cards WHERE id = ?`)
    .bind(id)
    .first<CardRow>();
}

/** デッキを 1 件取る。既定は固定デッキ。 */
export async function getDeck(
  db: D1Database,
  id: string = DEFAULT_DECK_ID,
): Promise<DeckRow | null> {
  return await db
    .prepare("SELECT id, name, created_at, updated_at FROM decks WHERE id = ?")
    .bind(id)
    .first<DeckRow>();
}
