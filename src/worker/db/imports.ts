import { toUtcIso } from "../time";
import { DEFAULT_DECK_ID } from "./constants";
import type { CardStateRow, ImportRow, NewImportedCard } from "./types";

const IMPORT_COLUMNS = "import_id, received_at, added, result";

/** D1 の 1 クエリあたりの bind パラメータ上限。複数行 INSERT はこれに収まるように分割する。 */
const MAX_BOUND_PARAMS = 100;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function placeholders(rows: number, columns: number): string {
  return Array.from({ length: rows }, () => `(${Array(columns).fill("?").join(", ")})`).join(", ");
}

/** 取り込みの記録を 1 件取る(再送ならこの result をそのまま返す)。 */
export async function getImport(db: D1Database, importId: string): Promise<ImportRow | null> {
  return await db
    .prepare(`SELECT ${IMPORT_COLUMNS} FROM imports WHERE import_id = ?`)
    .bind(importId)
    .first<ImportRow>();
}

/**
 * 生きているカードのうち、指定した front と一致するものを引く(重複 front の判定用)。
 * 論理削除済みのカードは対象にしない(消したカードは入れ直せる)。
 */
export async function findCardIdsByFront(
  db: D1Database,
  fronts: readonly string[],
  deckId: string = DEFAULT_DECK_ID,
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const unique = [...new Set(fronts)];
  if (unique.length === 0) return found;

  // deck_id の 1 つ分を残して分割する。
  for (const group of chunk(unique, MAX_BOUND_PARAMS - 1)) {
    const { results } = await db
      .prepare(
        `SELECT id, front FROM cards
         WHERE deck_id = ? AND deleted_at IS NULL
           AND front IN (${Array(group.length).fill("?").join(", ")})`,
      )
      .bind(deckId, ...group)
      .all<{ id: string; front: string }>();
    // 同じ front の既存カードが複数あっても、最初に見つけた 1 件を代表にする。
    for (const row of results) if (!found.has(row.front)) found.set(row.front, row.id);
  }
  return found;
}

/**
 * 取り込みを 1 トランザクション(D1 の batch)で書く。
 * cards・新規の card_state・imports(冪等キーと応答本文)をまとめて入れるので、
 * 途中で失敗したら 1 行も入らない。import_id が既にあれば主キー衝突で失敗する(= 再送は呼ぶ前に弾く)。
 */
export async function insertImport(
  db: D1Database,
  params: {
    importId: string;
    receivedAt: Date;
    /** 応答本文。再送でそのまま返す。 */
    result: unknown;
    /** 追加するカード(id は呼び出し側が採番する)。 */
    cards: readonly NewImportedCard[];
    deckId?: string;
  },
): Promise<void> {
  const deckId = params.deckId ?? DEFAULT_DECK_ID;
  const receivedAt = toUtcIso(params.receivedAt);
  const statements: D1PreparedStatement[] = [];

  const cardColumns = "id, deck_id, front, back, example, note, created_at, updated_at, deleted_at";
  for (const group of chunk(params.cards, Math.floor(MAX_BOUND_PARAMS / 9))) {
    statements.push(
      db
        .prepare(`INSERT INTO cards (${cardColumns}) VALUES ${placeholders(group.length, 9)}`)
        .bind(
          ...group.flatMap((card) => [
            card.id,
            deckId,
            card.front,
            card.back,
            card.example,
            card.note,
            receivedAt,
            receivedAt,
            null,
          ]),
        ),
    );
  }

  const stateColumns =
    "card_id, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, fsrs_state, last_review, version, updated_at";
  const states: CardStateRow[] = params.cards.map((card) => card.state);
  for (const group of chunk(states, Math.floor(MAX_BOUND_PARAMS / 13))) {
    statements.push(
      db
        .prepare(
          `INSERT INTO card_state (${stateColumns}) VALUES ${placeholders(group.length, 13)}`,
        )
        .bind(
          ...group.flatMap((state) => [
            state.card_id,
            state.due,
            state.stability,
            state.difficulty,
            state.elapsed_days,
            state.scheduled_days,
            state.learning_steps,
            state.reps,
            state.lapses,
            state.fsrs_state,
            state.last_review,
            state.version,
            state.updated_at,
          ]),
        ),
    );
  }

  statements.push(
    db
      .prepare(`INSERT INTO imports (${IMPORT_COLUMNS}) VALUES (?, ?, ?, ?)`)
      .bind(params.importId, receivedAt, params.cards.length, JSON.stringify(params.result)),
  );

  await db.batch(statements);
}
