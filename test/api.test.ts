import { afterEach, describe, expect, it, vi } from "vitest";
import { postCards } from "../src/client/api";
import type { ImportResponse, NormalizedCard } from "../src/shared/cards";

const IMPORT_ID = "11111111-2222-4333-8444-555555555555";
const CARDS: NormalizedCard[] = [{ front: "invoice", back: "請求書", example: null, note: null }];

const OK: ImportResponse = {
  import_id: IMPORT_ID,
  added: 1,
  skipped: 0,
  results: [{ row: 1, front: "invoice", added: true, card_id: "card-1" }],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

/** fetch を差し替えて、呼ばれた本文を記録する。 */
function stubFetch(handler: (body: string) => Promise<Response>): string[] {
  const bodies: string[] = [];
  vi.stubGlobal("fetch", async (_input: unknown, init?: { body?: unknown }) => {
    const body = String(init?.body ?? "");
    bodies.push(body);
    return await handler(body);
  });
  return bodies;
}

describe("postCards", () => {
  it("通信が失敗しても例外を出さず、再送できる案内を返す", async () => {
    stubFetch(async () => {
      throw new TypeError("Network connection lost.");
    });

    const result = await postCards(IMPORT_ID, CARDS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(0);
    expect(result.error.error).toBe("network_error");
    expect(result.error.message).toContain("もう一度送れる");
  });

  it("通信が失敗した後、同じ import_id と内容でそのまま再送できる", async () => {
    let calls = 0;
    const bodies = stubFetch(async () => {
      calls++;
      if (calls === 1) throw new TypeError("Network connection lost.");
      return Response.json(OK);
    });

    const first = await postCards(IMPORT_ID, CARDS);
    expect(first.ok).toBe(false);
    const second = await postCards(IMPORT_ID, CARDS);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.response).toEqual(OK);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(JSON.parse(String(bodies[0]))).toEqual({ import_id: IMPORT_ID, cards: CARDS });
  });

  it("成功応答が JSON として読めなくても例外を出さない", async () => {
    stubFetch(async () => new Response("<html>proxy</html>", { status: 200 }));

    const result = await postCards(IMPORT_ID, CARDS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(200);
    expect(result.error.error).toBe("network_error");
    expect(result.error.message).toContain("もう一度送れる");
  });

  it("4xx の行別エラーはそのまま画面に渡す", async () => {
    const body = {
      error: "invalid_cards",
      message: "無効な行がある",
      errors: [{ row: 1, field: "back", code: "required", message: "裏(back)は必須です" }],
    };
    stubFetch(async () => Response.json(body, { status: 400 }));

    const result = await postCards(IMPORT_ID, CARDS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.error).toEqual(body);
  });

  it("本文が JSON でない 4xx でも既定のメッセージで返す", async () => {
    stubFetch(async () => new Response("denied", { status: 403 }));

    const result = await postCards(IMPORT_ID, CARDS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(403);
    expect(result.error.message).toContain("403");
  });
});
