import { env } from "cloudflare:workers";
import { State } from "ts-fsrs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FIELD_LIMITS,
  type ImportErrorResponse,
  type ImportResponse,
  MAX_BODY_BYTES,
  MAX_CARDS_PER_IMPORT,
} from "../src/shared/cards";
import { DEFAULT_DECK_ID } from "../src/worker/db";
import { toUtcIso } from "../src/worker/time";
import { type AccessHarness, createAccessHarness, ORIGIN } from "./access-harness";

const NOW = new Date("2026-10-26T01:23:45.000Z");
const IMPORT_ID = "11111111-2222-4333-8444-555555555555";

let harness: AccessHarness;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  harness = await createAccessHarness(NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

// D1 はテスト間で共有されるので、書き込む表は毎回空にする(migration が入れた行は消さない)。
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM reviews"),
    env.DB.prepare("DELETE FROM card_state"),
    env.DB.prepare("DELETE FROM cards"),
    env.DB.prepare("DELETE FROM imports"),
  ]);
});

async function post(
  body: unknown,
  headers: Record<string, string> = {},
  path = "/api/cards",
): Promise<Response> {
  return await harness.app.request(
    `${ORIGIN}${path}`,
    {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN,
        "Cf-Access-Jwt-Assertion": harness.jwt,
        ...headers,
      },
    },
    harness.env,
  );
}

async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

async function counts(): Promise<{ cards: number; states: number; imports: number }> {
  return {
    cards: await count("cards"),
    states: await count("card_state"),
    imports: await count("imports"),
  };
}

const card = (front: string, back = `${front} の意味`) => ({ front, back });

describe("POST /api/cards(取り込み)", () => {
  it("カードと「新規」の card_state を同時に作る", async () => {
    const res = await post({
      import_id: IMPORT_ID,
      cards: [
        { front: "invoice", back: "請求書", example: "Please send the invoice.", note: " 頻出 " },
        { front: "ledger", back: "元帳" },
      ],
    });
    expect(res.status).toBe(200);

    const body = await res.json<ImportResponse>();
    expect(body.import_id).toBe(IMPORT_ID);
    expect(body.added).toBe(2);
    expect(body.skipped).toBe(0);
    expect(body.results.map((r) => [r.row, r.front, r.added])).toEqual([
      [1, "invoice", true],
      [2, "ledger", true],
    ]);

    const cardId = body.results[0]?.card_id ?? "";
    const row = await env.DB.prepare("SELECT * FROM cards WHERE id = ?")
      .bind(cardId)
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({
      deck_id: DEFAULT_DECK_ID,
      front: "invoice",
      back: "請求書",
      example: "Please send the invoice.",
      note: "頻出", // 前後の空白は落ちる
      created_at: toUtcIso(NOW),
      updated_at: toUtcIso(NOW),
      deleted_at: null,
    });

    // 任意項目を省いた行は NULL で入る。
    const second = await env.DB.prepare(
      "SELECT example, note FROM cards WHERE front = 'ledger'",
    ).first<{ example: string | null; note: string | null }>();
    expect(second).toEqual({ example: null, note: null });

    const state = await env.DB.prepare("SELECT * FROM card_state WHERE card_id = ?")
      .bind(cardId)
      .first<Record<string, unknown>>();
    expect(state).toMatchObject({
      fsrs_state: State.New,
      reps: 0,
      lapses: 0,
      last_review: null,
      version: 1,
      due: toUtcIso(NOW),
      updated_at: toUtcIso(NOW),
    });

    expect(await counts()).toEqual({ cards: 2, states: 2, imports: 1 });
  });

  it("無効な行が 1 つでもあれば D1 は一切変わらない(どの行がなぜ無効かを返す)", async () => {
    const res = await post({
      import_id: IMPORT_ID,
      cards: [
        card("invoice"),
        { front: "  ", back: "空白だけ" },
        { front: "ledger" },
        { front: "x".repeat(FIELD_LIMITS.front + 1), back: "長すぎる front" },
        "文字列",
      ],
    });
    expect(res.status).toBe(400);

    const body = await res.json<ImportErrorResponse>();
    expect(body.error).toBe("invalid_cards");
    expect(body.errors?.map((e) => [e.row, e.field, e.code])).toEqual([
      [2, "front", "required"],
      [3, "back", "required"],
      [4, "front", "too_long"],
      [5, null, "not_an_object"],
    ]);
    for (const e of body.errors ?? []) expect(e.message).not.toBe("");

    // 有効だった 1 行目も入っていない。冪等キーも記録しない(直して同じ import_id で送り直せる)。
    expect(await counts()).toEqual({ cards: 0, states: 0, imports: 0 });
  });

  it("文字数上限を超えた任意項目も 400 で、何も変わらない", async () => {
    const res = await post({
      import_id: IMPORT_ID,
      cards: [{ front: "invoice", back: "請求書", note: "あ".repeat(FIELD_LIMITS.note + 1) }],
    });
    expect(res.status).toBe(400);
    expect((await res.json<ImportErrorResponse>()).errors?.[0]).toMatchObject({
      row: 1,
      field: "note",
      code: "too_long",
    });
    expect(await counts()).toEqual({ cards: 0, states: 0, imports: 0 });
  });

  it("上限ちょうど(境界)は通る", async () => {
    const res = await post({
      import_id: IMPORT_ID,
      cards: [
        {
          front: "x".repeat(FIELD_LIMITS.front),
          back: "あ".repeat(FIELD_LIMITS.back),
          example: "e".repeat(FIELD_LIMITS.example),
          note: "n".repeat(FIELD_LIMITS.note),
        },
      ],
    });
    expect(res.status).toBe(200);
    expect((await res.json<ImportResponse>()).added).toBe(1);
  });

  it("同じ import_id の再送は前回と同じ結果を返し、カードを増やさない", async () => {
    const payload = { import_id: IMPORT_ID, cards: [card("invoice"), card("ledger")] };
    const first = await (await post(payload)).json<ImportResponse>();
    expect(first.added).toBe(2);

    const again = await post(payload);
    expect(again.status).toBe(200);
    expect(await again.json<ImportResponse>()).toEqual(first);
    expect(await counts()).toEqual({ cards: 2, states: 2, imports: 1 });

    // 中身を変えて同じ import_id で送っても、1 回目の結果が正(増やさない)。
    const changed = await post({ import_id: IMPORT_ID, cards: [card("totally new")] });
    expect(await changed.json<ImportResponse>()).toEqual(first);
    expect(await counts()).toEqual({ cards: 2, states: 2, imports: 1 });

    // 別の import_id なら追加される。
    const other = await post({
      import_id: "22222222-3333-4444-8555-666666666666",
      cards: [card("asset")],
    });
    expect((await other.json<ImportResponse>()).added).toBe(1);
    expect(await counts()).toEqual({ cards: 3, states: 3, imports: 2 });
  });

  it("既存と同じ front は警告だけで、上書きも追加もしない", async () => {
    await post({
      import_id: IMPORT_ID,
      cards: [{ front: "invoice", back: "請求書", note: "元のメモ" }],
    });
    const before = await env.DB.prepare("SELECT * FROM cards WHERE front = 'invoice'").first();

    const res = await post({
      import_id: "33333333-4444-4555-8666-777777777777",
      cards: [{ front: "invoice", back: "上書きしたい", note: "新しいメモ" }, card("ledger")],
    });
    expect(res.status).toBe(200);

    const body = await res.json<ImportResponse>();
    expect(body.added).toBe(1);
    expect(body.skipped).toBe(1);
    expect(body.results[0]).toMatchObject({
      row: 1,
      front: "invoice",
      added: false,
      warning: "duplicate_front",
    });
    expect(body.results[0]?.card_id).toBeUndefined();
    expect(body.results[1]).toMatchObject({ row: 2, front: "ledger", added: true });

    // 既存の行は 1 件のまま、1 文字も変わっていない。
    expect(await env.DB.prepare("SELECT * FROM cards WHERE front = 'invoice'").first()).toEqual(
      before,
    );
    expect(await counts()).toEqual({ cards: 2, states: 2, imports: 2 });
  });

  it("同じリクエストの中で front が重なったら最初の 1 行だけ追加する", async () => {
    const res = await post({
      import_id: IMPORT_ID,
      cards: [
        { front: "invoice", back: "請求書" },
        { front: "invoice", back: "インボイス" },
      ],
    });
    const body = await res.json<ImportResponse>();
    expect([body.added, body.skipped]).toEqual([1, 1]);
    expect(body.results[1]).toMatchObject({ added: false, warning: "duplicate_front" });
    expect(await count("cards")).toBe(1);
    expect((await env.DB.prepare("SELECT back FROM cards").first<{ back: string }>())?.back).toBe(
      "請求書",
    );
  });

  it("論理削除したカードと同じ front は入れ直せる", async () => {
    await post({ import_id: IMPORT_ID, cards: [card("invoice")] });
    await env.DB.prepare("UPDATE cards SET deleted_at = ? WHERE front = 'invoice'")
      .bind(toUtcIso(NOW))
      .run();

    const res = await post({
      import_id: "44444444-5555-4666-8777-888888888888",
      cards: [card("invoice")],
    });
    expect((await res.json<ImportResponse>()).added).toBe(1);
    expect(await count("cards")).toBe(2);
  });
});

describe("POST /api/cards(上限と形)", () => {
  it(`${MAX_CARDS_PER_IMPORT} 件は通り、+1 件は 400`, async () => {
    const cards = Array.from({ length: MAX_CARDS_PER_IMPORT }, (_, i) => card(`w${i}`));
    const ok = await post({ import_id: IMPORT_ID, cards });
    expect(ok.status).toBe(200);
    expect((await ok.json<ImportResponse>()).added).toBe(MAX_CARDS_PER_IMPORT);
    expect(await counts()).toEqual({
      cards: MAX_CARDS_PER_IMPORT,
      states: MAX_CARDS_PER_IMPORT,
      imports: 1,
    });

    const tooMany = await post({
      import_id: "55555555-6666-4777-8888-999999999999",
      cards: [...cards, card("overflow")],
    });
    expect(tooMany.status).toBe(400);
    const body = await tooMany.json<ImportErrorResponse>();
    expect(body.error).toBe("too_many_cards");
    expect(body.limit).toBe(MAX_CARDS_PER_IMPORT);
    expect(body.count).toBe(MAX_CARDS_PER_IMPORT + 1);
    // 501 件のほうは何も足していない。
    expect(await counts()).toEqual({
      cards: MAX_CARDS_PER_IMPORT,
      states: MAX_CARDS_PER_IMPORT,
      imports: 1,
    });
  });

  it("本文サイズ上限を超えたら 413(中身を見ずに拒否)", async () => {
    const huge = `{"import_id":"${IMPORT_ID}","cards":[{"front":"${"x".repeat(MAX_BODY_BYTES)}","back":"b"}]}`;
    const res = await post(huge);
    expect(res.status).toBe(413);
    const body = await res.json<ImportErrorResponse>();
    expect(body.error).toBe("payload_too_large");
    expect(body.limit).toBe(MAX_BODY_BYTES);
    expect(await counts()).toEqual({ cards: 0, states: 0, imports: 0 });
  });

  it("Content-Length だけが上限超えでも 413", async () => {
    const res = await post(
      { import_id: IMPORT_ID, cards: [card("invoice")] },
      {
        "Content-Length": String(MAX_BODY_BYTES + 1),
      },
    );
    expect(res.status).toBe(413);
    expect(await counts()).toEqual({ cards: 0, states: 0, imports: 0 });
  });

  it("JSON として壊れている本文は 400", async () => {
    const res = await post("{");
    expect(res.status).toBe(400);
    expect((await res.json<ImportErrorResponse>()).error).toBe("invalid_json");
  });

  it("配列やプリミティブの本文は 400", async () => {
    expect((await post("[]")).status).toBe(400);
    expect((await post('"x"')).status).toBe(400);
  });

  it("import_id が無い・空・長すぎるなら 400", async () => {
    for (const importId of [undefined, "", "   ", 1, "x".repeat(65)]) {
      const res = await post({ import_id: importId, cards: [card("invoice")] });
      expect(res.status, String(importId)).toBe(400);
      expect((await res.json<ImportErrorResponse>()).error).toBe("invalid_import_id");
    }
    expect(await counts()).toEqual({ cards: 0, states: 0, imports: 0 });
  });

  it("cards が配列でない・空なら 400", async () => {
    expect((await post({ import_id: IMPORT_ID })).status).toBe(400);
    const empty = await post({ import_id: IMPORT_ID, cards: [] });
    expect(empty.status).toBe(400);
    expect((await empty.json<ImportErrorResponse>()).error).toBe("no_cards");
    expect(await counts()).toEqual({ cards: 0, states: 0, imports: 0 });
  });
});

describe("POST /api/cards(ガード)", () => {
  it("Access JWT が無ければ 401(API 経路の認証切れ)", async () => {
    const res = await harness.app.request(
      `${ORIGIN}/api/cards`,
      {
        method: "POST",
        body: JSON.stringify({ import_id: IMPORT_ID, cards: [card("invoice")] }),
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
      },
      harness.env,
    );
    expect(res.status).toBe(401);
    expect((await res.json<{ error: string }>()).error).toBe("unauthenticated");
    expect(await counts()).toEqual({ cards: 0, states: 0, imports: 0 });
  });

  it("別 Origin / Origin 無しは 403", async () => {
    expect(
      (
        await post(
          { import_id: IMPORT_ID, cards: [card("a")] },
          { Origin: "https://evil.example.com" },
        )
      ).status,
    ).toBe(403);
    const res = await harness.app.request(
      `${ORIGIN}/api/cards`,
      {
        method: "POST",
        body: JSON.stringify({ import_id: IMPORT_ID, cards: [card("invoice")] }),
        headers: { "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": harness.jwt },
      },
      harness.env,
    );
    expect(res.status).toBe(403);
    expect(await counts()).toEqual({ cards: 0, states: 0, imports: 0 });
  });

  it("JSON 以外の Content-Type は 415", async () => {
    const res = await post(
      { import_id: IMPORT_ID, cards: [card("a")] },
      {
        "Content-Type": "text/plain",
      },
    );
    expect(res.status).toBe(415);
    expect(await counts()).toEqual({ cards: 0, states: 0, imports: 0 });
  });

  it("GET /api/cards は経路が無いので 404", async () => {
    const res = await harness.app.request(
      `${ORIGIN}/api/cards`,
      { headers: { "Cf-Access-Jwt-Assertion": harness.jwt } },
      harness.env,
    );
    expect(res.status).toBe(404);
  });
});
