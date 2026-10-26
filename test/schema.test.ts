import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DEFAULT_DECK_ID } from "../src/worker/db";

const TABLES = ["cards", "decks", "card_state", "reviews", "settings"];

async function tableNames(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).all<{ name: string }>();
  return results.map((r) => r.name);
}

async function columnNames(table: string): Promise<string[]> {
  const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return results.map((r) => r.name);
}

async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

/** migration の SQL から `--` のコメントを落とす。 */
function stripComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

describe("0001_init.sql", () => {
  it("5 つのテーブルができる", async () => {
    const names = await tableNames();
    for (const table of TABLES) expect(names, table).toContain(table);
  });

  it("カードは UUID の id・front / back・論理削除の deleted_at を持つ", async () => {
    expect(await columnNames("cards")).toEqual(
      expect.arrayContaining([
        "id",
        "deck_id",
        "front",
        "back",
        "deleted_at",
        "created_at",
        "updated_at",
      ]),
    );
  });

  it("card_state の State 列は fsrs_state", async () => {
    expect(await columnNames("card_state")).toContain("fsrs_state");
  });

  it("card_state は楽観ロックの version を持つ", async () => {
    const { results } = await env.DB.prepare("PRAGMA table_info(card_state)").all<{
      name: string;
      notnull: number;
    }>();
    const version = results.find((c) => c.name === "version");
    expect(version).toBeDefined();
    expect(version?.notnull).toBe(1);
  });

  it("reviews は review_id が主キーで、冪等に必要な列がそろっている", async () => {
    const { results } = await env.DB.prepare("PRAGMA table_info(reviews)").all<{
      name: string;
      pk: number;
    }>();
    expect(results.filter((c) => c.pk > 0).map((c) => c.name)).toEqual(["review_id"]);
    expect(results.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        "occurred_at",
        "received_at",
        "state_before",
        "state_after",
        "review_log",
        "fsrs_version",
        "params_version",
        "correction_of",
      ]),
    );
  });

  it("reviews の elapsed_ms は INTEGER で NULL 可", async () => {
    const { results } = await env.DB.prepare("PRAGMA table_info(reviews)").all<{
      name: string;
      type: string;
      notnull: number;
    }>();
    const elapsed = results.find((c) => c.name === "elapsed_ms");
    expect(elapsed).toBeDefined();
    expect(elapsed?.type).toBe("INTEGER");
    expect(elapsed?.notnull).toBe(0);
  });

  it("固定デッキが 1 件だけ入っている", async () => {
    expect(await count("decks")).toBe(1);
    const deck = await env.DB.prepare("SELECT id, name FROM decks").first<{
      id: string;
      name: string;
    }>();
    expect(deck?.id).toBe(DEFAULT_DECK_ID);
    expect(deck?.name).not.toBe("");
  });

  it("settings が 1 行だけ入っていて、2 行目は入れられない", async () => {
    expect(await count("settings")).toBe(1);
    await expect(
      env.DB.prepare(
        `INSERT INTO settings (id, timezone, new_cards_per_day, learning_steps, relearning_steps,
           request_retention, maximum_interval, enable_fuzz, enable_short_term, fsrs_w,
           params_version, updated_at)
         VALUES (2, 'Asia/Tokyo', 10, '[]', '[]', 0.9, 36500, 0, 1, '[]', 1, '2026-10-25T00:00:00.000Z')`,
      ).run(),
    ).rejects.toThrow();
  });

  it("入っている時刻はすべて UTC の ISO 8601 文字列", async () => {
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    const deck = await env.DB.prepare("SELECT created_at, updated_at FROM decks").first<{
      created_at: string;
      updated_at: string;
    }>();
    expect(deck?.created_at).toMatch(iso);
    expect(deck?.updated_at).toMatch(iso);
    const settings = await env.DB.prepare("SELECT updated_at FROM settings").first<{
      updated_at: string;
    }>();
    expect(settings?.updated_at).toMatch(iso);
  });
});

describe("0002_imports.sql", () => {
  it("imports は import_id が主キーで、応答本文を持つ", async () => {
    const { results } = await env.DB.prepare("PRAGMA table_info(imports)").all<{
      name: string;
      pk: number;
      notnull: number;
    }>();
    expect(results.filter((c) => c.pk > 0).map((c) => c.name)).toEqual(["import_id"]);
    expect(results.map((c) => c.name)).toEqual(
      expect.arrayContaining(["received_at", "added", "result"]),
    );
    for (const column of results) expect(column.notnull, column.name).toBe(1);
  });

  it("同じ import_id は 2 回入らない", async () => {
    await env.DB.prepare(
      "INSERT INTO imports (import_id, received_at, added, result) VALUES ('i1', '2026-10-26T00:00:00.000Z', 0, '{}')",
    ).run();
    await expect(
      env.DB.prepare(
        "INSERT INTO imports (import_id, received_at, added, result) VALUES ('i1', '2026-10-26T00:00:00.000Z', 0, '{}')",
      ).run(),
    ).rejects.toThrow();
    await env.DB.prepare("DELETE FROM imports WHERE import_id = 'i1'").run();
  });
});

describe("0003_reviews_version_before.sql", () => {
  it("reviews に version_before(INTEGER・NULL 可)が足されている", async () => {
    const { results } = await env.DB.prepare("PRAGMA table_info(reviews)").all<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>();
    const column = results.find((c) => c.name === "version_before");
    expect(column).toBeDefined();
    expect(column?.type).toBe("INTEGER");
    // 旧コードが入れた行と既存行は NULL になる(新旧コード互換)。主キーは review_id のまま。
    expect(column?.notnull).toBe(0);
    expect(column?.pk).toBe(0);
    expect(results.filter((c) => c.pk > 0).map((c) => c.name)).toEqual(["review_id"]);
  });

  it("version_before を書かない INSERT も通る(列は NULL になる)", async () => {
    const at = "2026-10-26T00:00:00.000Z";
    await env.DB.prepare(
      `INSERT INTO cards (id, deck_id, front, back, created_at, updated_at)
       VALUES ('legacy-card', ?, 'invoice', '請求書', ?, ?)`,
    )
      .bind(DEFAULT_DECK_ID, at, at)
      .run();
    // 列を知らない旧コードの INSERT(列を列挙する)がそのまま通ること。
    await env.DB.prepare(
      `INSERT INTO reviews (review_id, card_id, rating, occurred_at, received_at, state_before,
         state_after, review_log, fsrs_version, params_version)
       VALUES ('legacy', 'legacy-card', 3, ?, ?, '{}', '{}', '{}', 'x', 1)`,
    )
      .bind(at, at)
      .run();

    const row = await env.DB.prepare(
      "SELECT version_before FROM reviews WHERE review_id = 'legacy'",
    ).first<{ version_before: number | null }>();
    expect(row?.version_before).toBeNull();

    await env.DB.batch([
      env.DB.prepare("DELETE FROM reviews WHERE review_id = 'legacy'"),
      env.DB.prepare("DELETE FROM cards WHERE id = 'legacy-card'"),
    ]);
  });
});

describe("migration の運用", () => {
  it("0001 から順に並んでいる", () => {
    expect(env.TEST_MIGRATIONS.map((m) => m.name)).toEqual([
      "0001_init.sql",
      "0002_imports.sql",
      "0003_reviews_version_before.sql",
    ]);
  });

  it("追加のみ(DROP・列削除が無い)", () => {
    for (const migration of env.TEST_MIGRATIONS) {
      for (const query of migration.queries) {
        expect(stripComments(query), migration.name).not.toMatch(/\bdrop\b/i);
      }
    }
  });

  it("空の DB からの更新を 2 回適用しても失敗しない(applyD1Migrations)", async () => {
    // setupFiles で 1 回適用済み。同じものをもう 1 度流しても落ちず、行も増えない。
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    expect(await tableNames()).toEqual(expect.arrayContaining(TABLES));
    expect(await count("decks")).toBe(1);
    expect(await count("settings")).toBe(1);
  });

  it("適用済みの DB に、別の接続から migration の SQL を素のまま流しても壊れない", async () => {
    // applyD1Migrations は d1_migrations を見るので 2 回目は何もしない。
    // 追跡表を介さない経路(= 別セッションでの素の実行)でも、行も設定値も変わらないこと。
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const before = await env.DB.prepare("SELECT * FROM settings WHERE id = 1").first();

    const session = env.DB.withSession("first-primary");
    for (const migration of env.TEST_MIGRATIONS) {
      for (const query of migration.queries) {
        try {
          await session.prepare(query).run();
        } catch (error) {
          // SQLite の ALTER TABLE ADD COLUMN には IF NOT EXISTS が無いので、列がある分だけは
          // 落ちる(何も書き換えない)。それ以外の文が落ちるのは migration の書き方の誤り。
          expect(stripComments(query), migration.name).toMatch(/^\s*ALTER TABLE \w+ ADD COLUMN\b/i);
          expect(String(error), migration.name).toMatch(/duplicate column name/);
        }
      }
    }

    expect(await tableNames()).toEqual(expect.arrayContaining(TABLES));
    expect(await columnNames("cards")).toEqual(expect.arrayContaining(["front", "back"]));
    expect(await columnNames("reviews")).toEqual(
      expect.arrayContaining(["elapsed_ms", "version_before"]),
    );
    expect(await count("decks")).toBe(1);
    expect(await count("settings")).toBe(1);
    expect(await env.DB.prepare("SELECT * FROM settings WHERE id = 1").first()).toEqual(before);
  });
});
