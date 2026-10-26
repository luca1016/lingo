// 画面の状態遷移(入力内容と import_id の組、送信中の扱い)のテスト。
// 画面の状態は src/client/draft.ts(+ 貼り付けのプレビューは src/client/preview.ts)に切り出してあり、
// ここでは App.tsx の各 handler と同じ順で遷移を動かす箱(useState の代わり)を作って検証する
// (workerd 上のテストに DOM は無いので、描画ではなく状態遷移そのものを押さえる)。

import { afterEach, describe, expect, it, vi } from "vitest";
import { newImportId } from "../src/client/api";
import {
  type Draft,
  type DraftContent,
  editDraft,
  isLocked,
  newDraft,
  resetDraft,
  submitDraft,
} from "../src/client/draft";
import { buildPreview, canImport } from "../src/client/preview";
import { type ImportResponse, normalizeRow } from "../src/shared/cards";

const EMPTY_CARD: DraftContent = { front: "", back: "", example: "", note: "" };

function okResponse(importId: string): ImportResponse {
  return {
    import_id: importId,
    added: 1,
    skipped: 0,
    results: [{ row: 1, front: "invoice", added: true, card_id: "card-1" }],
  };
}

interface SentBody {
  import_id: string;
  cards: { front: string; back: string }[];
}

/** fetch を差し替えて、送った本文を記録する。 */
function stubFetch(handler: (body: SentBody) => Promise<Response>): SentBody[] {
  const sent: SentBody[] = [];
  vi.stubGlobal("fetch", async (_input: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as SentBody;
    sent.push(body);
    return await handler(body);
  });
  return sent;
}

/** 解決を自分で起こせる応答(「送信中」の状態を観察するため)。 */
function deferred(): { promise: Promise<Response>; resolve: (res: Response) => void } {
  let resolve: (res: Response) => void = () => {};
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** 画面の useState の代わり。import_id の採番は順番の分かる値に差し替える。 */
class Screen {
  draft: Draft;
  private minted = 0;

  constructor(empty: DraftContent) {
    this.draft = newDraft(empty, this.mint);
  }

  mint = (): string => `import-${++this.minted}`;

  set = (value: Draft | ((prev: Draft) => Draft)): void => {
    this.draft = typeof value === "function" ? value(this.draft) : value;
  };
}

/** 単票追加の画面(App.tsx の SingleCard と同じ遷移)。 */
class SingleScreen extends Screen {
  constructor() {
    super(EMPTY_CARD);
  }

  /** 入力(送信中は画面側で disabled。来ても editDraft が無視する)。 */
  type(patch: DraftContent): void {
    this.set((prev) => editDraft(prev, { ...prev.content, ...patch }, this.mint));
  }

  async submit(): Promise<boolean> {
    const draft = this.draft;
    const local = normalizeRow(draft.content, 1);
    if (isLocked(draft) || !local.card) return false;
    const ok = await submitDraft(draft, [local.card], this.set);
    if (ok) this.set((prev) => resetDraft(prev, EMPTY_CARD, this.mint));
    return ok;
  }
}

/** 貼り付け取り込みの画面(App.tsx の PasteImport と同じ遷移)。 */
class PasteScreen extends Screen {
  previewed: string | null = null;

  constructor() {
    super({ text: "" });
  }

  get text(): string {
    return this.draft.content.text ?? "";
  }

  type(text: string): void {
    this.set((prev) => editDraft(prev, { text }, this.mint));
  }

  showPreview(): void {
    this.previewed = this.text;
  }

  /** いまの入力と一致したプレビューだけを出す(古いプレビューの内容は送らない)。 */
  get preview() {
    return this.previewed !== null && this.previewed === this.text ? buildPreview(this.text) : null;
  }

  async confirm(): Promise<boolean> {
    const preview = this.preview;
    if (isLocked(this.draft) || !preview || !canImport(preview)) return false;
    const ok = await submitDraft(this.draft, preview.cards, this.set);
    if (ok) {
      this.previewed = null;
      this.set((prev) => resetDraft(prev, { text: "" }, this.mint));
    }
    return ok;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("import_id と入力内容の組", () => {
  it("内容を変えたら新しい import_id を割り当てる", () => {
    const screen = new SingleScreen();
    const first = screen.draft.importId;

    screen.type({ front: "invoice" });
    const second = screen.draft.importId;
    expect(second).not.toBe(first);

    screen.type({ back: "請求書" });
    expect(screen.draft.importId).not.toBe(second);
  });

  it("同じ値が入力されただけなら import_id は変えない", () => {
    const screen = new SingleScreen();
    screen.type({ front: "invoice" });
    const id = screen.draft.importId;

    screen.type({ front: "invoice" });
    expect(screen.draft.importId).toBe(id);
  });

  it("newImportId は毎回違うキーを返す", () => {
    expect(newImportId()).not.toBe(newImportId());
  });
});

describe("単票追加(応答が消えたあと)", () => {
  it("内容を変えずに再送すると、同じ import_id と同じ本文で送る(冪等応答を受け取る)", async () => {
    let calls = 0;
    const sent = stubFetch(async (body) => {
      calls++;
      if (calls === 1) throw new TypeError("Network connection lost.");
      return Response.json(okResponse(body.import_id));
    });

    const screen = new SingleScreen();
    screen.type({ front: "invoice", back: "請求書" });
    const id = screen.draft.importId;

    expect(await screen.submit()).toBe(false);
    expect(screen.draft.failure).toContain("もう一度送れる");
    // 入力も冪等キーも残っているので、そのまま再送できる。
    expect(screen.draft.content.front).toBe("invoice");
    expect(screen.draft.importId).toBe(id);
    expect(isLocked(screen.draft)).toBe(false);

    expect(await screen.submit()).toBe(true);
    expect(sent.map((body) => body.import_id)).toEqual([id, id]);
    expect(sent[0]).toEqual(sent[1]);
    expect(screen.draft.result?.added).toBe(1);
    expect(screen.draft.failure).toBeNull();
  });

  it("内容を変えてから再送すると、新しい import_id で変更後の内容を送る", async () => {
    let calls = 0;
    const sent = stubFetch(async (body) => {
      calls++;
      if (calls === 1) throw new TypeError("Network connection lost.");
      return Response.json(okResponse(body.import_id));
    });

    const screen = new SingleScreen();
    screen.type({ front: "invoice", back: "請求書" });
    const first = screen.draft.importId;
    expect(await screen.submit()).toBe(false);

    // 応答が消えたあとに裏を直した。前回のキーで送ると「変更が保存されないのに成功」になる。
    screen.type({ back: "インボイス" });
    const second = screen.draft.importId;
    expect(second).not.toBe(first);
    expect(screen.draft.failure).toBeNull();

    expect(await screen.submit()).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[0]?.import_id).toBe(first);
    expect(sent[0]?.cards[0]?.back).toBe("請求書");
    expect(sent[1]?.import_id).toBe(second);
    expect(sent[1]?.cards[0]?.back).toBe("インボイス");
  });
});

describe("単票追加(送信中)", () => {
  it("送信中は編集を受け付けず、送った内容と import_id の組が崩れない", async () => {
    const pending = deferred();
    const sent = stubFetch(async () => await pending.promise);

    const screen = new SingleScreen();
    screen.type({ front: "invoice", back: "請求書" });
    const id = screen.draft.importId;

    const running = screen.submit();
    expect(isLocked(screen.draft)).toBe(true);

    // 画面では入力を disabled にしているが、来ても内容とキーは動かさない。
    screen.type({ front: "ledger", back: "元帳" });
    expect(screen.draft.content.front).toBe("invoice");
    expect(screen.draft.importId).toBe(id);

    pending.resolve(Response.json(okResponse(id)));
    expect(await running).toBe(true);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.import_id).toBe(id);
    expect(sent[0]?.cards[0]?.front).toBe("invoice");
    // 成功したら次の 1 枚へ(内容が変わるので import_id も新しい)。結果の表示は残す。
    expect(screen.draft.content).toEqual(EMPTY_CARD);
    expect(screen.draft.importId).not.toBe(id);
    expect(screen.draft.result?.added).toBe(1);
    expect(isLocked(screen.draft)).toBe(false);
  });

  it("送信中の二重送信では 2 回目を送らない", async () => {
    const pending = deferred();
    const sent = stubFetch(async () => await pending.promise);

    const screen = new SingleScreen();
    screen.type({ front: "invoice", back: "請求書" });
    const id = screen.draft.importId;

    const running = screen.submit();
    expect(await screen.submit()).toBe(false);

    pending.resolve(Response.json(okResponse(id)));
    expect(await running).toBe(true);
    expect(sent).toHaveLength(1);
  });
});

describe("貼り付け取り込みの画面", () => {
  it("プレビューのあとに本文を変えると import_id が変わり、古いプレビューは送れない", async () => {
    const sent = stubFetch(async (body) => Response.json(okResponse(body.import_id)));

    const screen = new PasteScreen();
    screen.type("invoice\t請求書");
    screen.showPreview();
    expect(screen.preview?.cards).toHaveLength(1);
    const first = screen.draft.importId;

    screen.type("invoice\t請求書\nledger\t元帳");
    const second = screen.draft.importId;
    expect(second).not.toBe(first);
    // 入力が変わったのでプレビューは出し直し(確定ボタンも押せない)。
    expect(screen.preview).toBeNull();
    expect(await screen.confirm()).toBe(false);
    expect(sent).toHaveLength(0);

    screen.showPreview();
    expect(screen.preview?.cards).toHaveLength(2);
    expect(await screen.confirm()).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.import_id).toBe(second);
    expect(sent[0]?.cards).toHaveLength(2);
  });

  it("応答が消えたあと、同じ本文のまま再送すると同じ import_id で送る", async () => {
    let calls = 0;
    const sent = stubFetch(async (body) => {
      calls++;
      if (calls === 1) return new Response("<html>proxy</html>", { status: 200 });
      return Response.json(okResponse(body.import_id));
    });

    const screen = new PasteScreen();
    screen.type("invoice\t請求書");
    screen.showPreview();
    const id = screen.draft.importId;

    // 200 なのに本文が読めない(結果が不明)。入力とプレビューは残す。
    expect(await screen.confirm()).toBe(false);
    expect(screen.draft.failure).toContain("もう一度送れる");
    expect(screen.text).toBe("invoice\t請求書");
    expect(screen.preview?.cards).toHaveLength(1);

    expect(await screen.confirm()).toBe(true);
    expect(sent.map((body) => body.import_id)).toEqual([id, id]);
    expect(sent[0]).toEqual(sent[1]);
    // 取り込めたら入力とプレビューを片付ける(未送信の編集は無い:送信中は編集できない)。
    expect(screen.text).toBe("");
    expect(screen.previewed).toBeNull();
    expect(screen.draft.result?.added).toBe(1);
  });

  it("送信中の編集は無視し、プレビューした内容をそのまま送る", async () => {
    const pending = deferred();
    const sent = stubFetch(async () => await pending.promise);

    const screen = new PasteScreen();
    screen.type("invoice\t請求書");
    screen.showPreview();
    const id = screen.draft.importId;

    const running = screen.confirm();
    expect(isLocked(screen.draft)).toBe(true);

    screen.type("ledger\t元帳");
    expect(screen.text).toBe("invoice\t請求書");
    expect(screen.draft.importId).toBe(id);

    pending.resolve(Response.json(okResponse(id)));
    expect(await running).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.cards[0]?.front).toBe("invoice");
  });
});

describe("draft の遷移(細かい規則)", () => {
  it("編集では直前の結果表示を消さない(失敗の表示だけ消す)", () => {
    const base = newDraft(EMPTY_CARD, () => "id-1");
    const sent: Draft = {
      ...base,
      failure: "通信できなかった",
      result: okResponse("id-1"),
    };

    const next = editDraft(sent, { ...EMPTY_CARD, front: "invoice" }, () => "id-2");
    expect(next.importId).toBe("id-2");
    expect(next.failure).toBeNull();
    expect(next.result).toEqual(okResponse("id-1"));
  });

  it("送信を始めるときに前回の結果と失敗を捨てる", async () => {
    stubFetch(async (body) => Response.json(okResponse(body.import_id)));
    const screen = new SingleScreen();
    screen.type({ front: "invoice", back: "請求書" });

    const states: Draft[] = [];
    const draft = screen.draft;
    await submitDraft(
      draft,
      [{ front: "invoice", back: "請求書", example: null, note: null }],
      (next) => {
        states.push(next);
      },
    );

    expect(states[0]?.sending).toBe(true);
    expect(states[0]?.result).toBeNull();
    expect(states[0]?.failure).toBeNull();
    expect(states[1]?.sending).toBe(false);
    expect(states[1]?.result?.import_id).toBe(draft.importId);
  });
});
