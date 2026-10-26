// 送信草稿(入力内容と import_id の組)の規則のテスト。
// 画面から押したときの遷移は test/app.test.ts で実画面(App.tsx)を描画して検証する。
// ここは src/client/draft.ts の規則そのもの(どの操作でキーが変わる・変わらないか)を直に押さえる。

import { afterEach, describe, expect, it, vi } from "vitest";
import { newImportId } from "../src/client/api";
import {
  type Draft,
  type DraftContent,
  editDraft,
  isLocked,
  newDraft,
  resetDraft,
  sameContent,
  submitDraft,
} from "../src/client/draft";
import type { ImportResponse, NormalizedCard } from "../src/shared/cards";

const EMPTY_CARD: DraftContent = { front: "", back: "", example: "", note: "" };
const CARD: NormalizedCard = { front: "invoice", back: "請求書", example: null, note: null };

function okResponse(importId: string): ImportResponse {
  return {
    import_id: importId,
    added: 1,
    skipped: 0,
    results: [{ row: 1, front: "invoice", added: true, card_id: "card-1" }],
  };
}

/** fetch を差し替えて、送った本文を記録する。 */
function stubFetch(handler: (body: { import_id: string }) => Promise<Response>) {
  const sent: { import_id: string }[] = [];
  vi.stubGlobal("fetch", async (_input: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { import_id: string };
    sent.push(body);
    return await handler(body);
  });
  return sent;
}

/** useState の代わり(最後の状態だけ覚える)。 */
function box(draft: Draft) {
  const state = {
    draft,
    set: (next: Draft) => {
      state.draft = next;
    },
  };
  return state;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("import_id と入力内容の組", () => {
  it("内容を変えたら新しい import_id を割り当てる", () => {
    let minted = 0;
    const mint = () => `import-${++minted}`;
    const first = newDraft(EMPTY_CARD, mint);

    const second = editDraft(first, { ...EMPTY_CARD, front: "invoice" }, mint);
    expect(second.importId).not.toBe(first.importId);

    const third = editDraft(second, { ...second.content, back: "請求書" }, mint);
    expect(third.importId).not.toBe(second.importId);
  });

  it("同じ値が入力されただけなら import_id は変えない", () => {
    const draft = newDraft({ ...EMPTY_CARD, front: "invoice" }, () => "id-1");
    const same = editDraft(draft, { ...EMPTY_CARD, front: "invoice" }, () => "id-2");
    expect(same.importId).toBe("id-1");
  });

  it("空文字と未設定は同じ内容として見る", () => {
    expect(sameContent({ text: "" }, {})).toBe(true);
    expect(sameContent({ text: "a" }, {})).toBe(false);
  });

  it("次の入力に移るとき(送信後)は新しい import_id にする", () => {
    const draft = { ...newDraft({ front: "invoice" }, () => "id-1"), result: okResponse("id-1") };
    const next = resetDraft(draft, EMPTY_CARD, () => "id-2");
    expect(next.importId).toBe("id-2");
    expect(next.content).toEqual(EMPTY_CARD);
    // 直前の取り込み結果は残す(何件追加できたかを読めるように)。
    expect(next.result).toEqual(okResponse("id-1"));
  });

  it("newImportId は毎回違うキーを返す", () => {
    expect(newImportId()).not.toBe(newImportId());
  });

  it("編集では直前の結果表示を消さない(失敗の表示だけ消す)", () => {
    const base = newDraft(EMPTY_CARD, () => "id-1");
    const sent: Draft = { ...base, failure: "通信できなかった", result: okResponse("id-1") };

    const next = editDraft(sent, { ...EMPTY_CARD, front: "invoice" }, () => "id-2");
    expect(next.importId).toBe("id-2");
    expect(next.failure).toBeNull();
    expect(next.result).toEqual(okResponse("id-1"));
  });

  it("送信中は編集も「次の入力へ」も受け付けない", () => {
    const sending: Draft = { ...newDraft({ front: "invoice" }, () => "id-1"), sending: true };
    expect(isLocked(sending)).toBe(true);
    expect(editDraft(sending, { front: "ledger" }, () => "id-2")).toBe(sending);
    expect(resetDraft(sending, EMPTY_CARD, () => "id-2")).toBe(sending);
  });
});

describe("submitDraft", () => {
  it("送信を始めるときに前回の結果と失敗を捨て、終わりに送信中を解く", async () => {
    stubFetch(async (body) => Response.json(okResponse(body.import_id)));
    const draft: Draft = {
      ...newDraft({ front: "invoice" }, () => "id-1"),
      failure: "前回の失敗",
      result: okResponse("id-0"),
    };

    const states: Draft[] = [];
    expect(await submitDraft(draft, [CARD], (next) => states.push(next))).toBe(true);

    expect(states[0]?.sending).toBe(true);
    expect(states[0]?.result).toBeNull();
    expect(states[0]?.failure).toBeNull();
    expect(states[1]?.sending).toBe(false);
    expect(states[1]?.result?.import_id).toBe("id-1");
  });

  it("通信できなかったら内容と import_id を残す(そのまま再送できる)", async () => {
    const sent = stubFetch(async () => {
      throw new TypeError("Network connection lost.");
    });
    const state = box(newDraft({ front: "invoice" }, () => "id-1"));

    expect(await submitDraft(state.draft, [CARD], state.set)).toBe(false);
    expect(state.draft.failure).toContain("もう一度送れる");
    expect(state.draft.content).toEqual({ front: "invoice" });
    expect(state.draft.importId).toBe("id-1");
    expect(isLocked(state.draft)).toBe(false);
    expect(sent[0]?.import_id).toBe("id-1");
  });

  it("4xx の行別エラーを画面に渡す", async () => {
    stubFetch(async () =>
      Response.json(
        {
          error: "invalid_rows",
          message: "無効な行がある",
          errors: [{ row: 1, field: "front", code: "too_long", message: "長すぎる" }],
        },
        { status: 400 },
      ),
    );
    const state = box(newDraft({ front: "invoice" }, () => "id-1"));

    expect(await submitDraft(state.draft, [CARD], state.set)).toBe(false);
    expect(state.draft.errors).toHaveLength(1);
    expect(state.draft.errors[0]?.message).toBe("長すぎる");
    // 直せるように内容とキーはそのまま(内容を直せば新しいキーになる)。
    expect(state.draft.importId).toBe("id-1");
  });
});
