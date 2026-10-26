// 画面(src/client/App.tsx)そのものを描画して、状態遷移を検証する。
// 応答消失 → 編集 → 再送、送信中の編集、タブの往復を、実際の入力・押下イベントで動かす。
// DOM は test/dom.ts の最小実装(workerd に DOM が無く、依存は増やさない)。

import { h } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/client/App";
import {
  buttonByText,
  byTag,
  click,
  type FakeElement,
  fieldByLabel,
  flush,
  mount,
  textOf,
  type,
} from "./dom";

interface SentBody {
  import_id: string;
  cards: { front: string; back: string; example: string | null; note: string | null }[];
}

/** fetch を差し替えて、送った本文を記録する。 */
function stubFetch(handler: (body: SentBody, call: number) => Promise<Response>): SentBody[] {
  const sent: SentBody[] = [];
  vi.stubGlobal("fetch", async (_input: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as SentBody;
    sent.push(body);
    return await handler(body, sent.length);
  });
  return sent;
}

/** 解決を自分で起こせる応答(「送信中」の画面を観察するため)。 */
function deferred(): { promise: Promise<Response>; resolve: (res: Response) => void } {
  let resolve: (res: Response) => void = () => {};
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function okResponse(importId: string, added = 1): Response {
  return Response.json({
    import_id: importId,
    added,
    skipped: 0,
    results: [{ row: 1, front: "invoice", added: true, card_id: "card-1" }],
  });
}

/** 1 回目は通信が切れ、2 回目以降は成功する。 */
function lostThenOk(): SentBody[] {
  return stubFetch(async (body, call) => {
    if (call === 1) throw new TypeError("Network connection lost.");
    return okResponse(body.import_id);
  });
}

const FRONT = "表(単語)";
const BACK = "裏(意味)";

function screen() {
  const root = mount(h(App, null));
  return {
    root,
    front: () => fieldByLabel(root, FRONT),
    back: () => fieldByLabel(root, BACK),
    paste: () => byTag(root, "textarea")[0] as FakeElement,
    add: () => buttonByText(root, "追加する"),
    text: () => textOf(root),
    toPaste: () => click(buttonByText(root, "貼り付け取り込み")),
    toSingle: () => click(buttonByText(root, "単票追加")),
  };
}

/** 単票追加の画面に 1 枚入力する。 */
async function fillCard(s: ReturnType<typeof screen>, front: string, back: string) {
  await type(s.front(), front);
  await type(s.back(), back);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("単票追加の画面", () => {
  it("応答が消えたあと、同じ内容のまま再送すると同じ import_id・同じ本文で送る", async () => {
    const sent = lostThenOk();
    const s = screen();
    await fillCard(s, "invoice", "請求書");

    await click(s.add());
    expect(s.text()).toContain("もう一度送れる");
    // 入力は残っていて、そのまま押し直せる。
    expect(s.front().value).toBe("invoice");
    expect(s.front().disabled).toBe(false);

    await click(s.add());
    expect(sent).toHaveLength(2);
    expect(sent[0]?.import_id).toBe(sent[1]?.import_id);
    expect(sent[0]).toEqual(sent[1]);
    expect(s.text()).toContain("追加 1 件");
    expect(s.text()).not.toContain("もう一度送れる");
    // 追加できたら次の 1 枚へ(入力は空、結果の表示は残る)。
    expect(s.front().value).toBe("");
  });

  it("応答が消えたあとに入力を直して再送すると、新しい import_id で直した内容を送る", async () => {
    const sent = lostThenOk();
    const s = screen();
    await fillCard(s, "invoice", "請求書");

    await click(s.add());
    expect(s.text()).toContain("もう一度送れる");

    await type(s.back(), "インボイス");
    // 入力を直したら前回の失敗表示は消す(直した内容で送り直すところから)。
    expect(s.text()).not.toContain("もう一度送れる");

    await click(s.add());
    expect(sent).toHaveLength(2);
    expect(sent[0]?.import_id).not.toBe(sent[1]?.import_id);
    expect(sent[0]?.cards[0]?.back).toBe("請求書");
    expect(sent[1]?.cards[0]?.back).toBe("インボイス");
  });

  it("送信中は入力できず、送った内容と import_id の組が崩れない", async () => {
    const pending = deferred();
    const sent = stubFetch(async () => await pending.promise);
    const s = screen();
    await fillCard(s, "invoice", "請求書");

    await click(s.add());
    expect(s.text()).toContain("送信中…");
    expect(s.front().disabled).toBe(true);
    expect(s.back().disabled).toBe(true);
    expect(buttonByText(s.root, "送信中…").disabled).toBe(true);

    // 入力を試みても(disabled なので)何も起きない。押し直しても二重に送らない。
    await type(s.front(), "ledger");
    expect(s.front().value).toBe("invoice");
    await click(buttonByText(s.root, "送信中…"));
    expect(sent).toHaveLength(1);

    pending.resolve(okResponse(sent[0]?.import_id ?? ""));
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.cards[0]?.front).toBe("invoice");
    expect(s.text()).toContain("追加 1 件");
    expect(s.front().disabled).toBe(false);
  });

  it("空のまま送ろうとすると行の理由を出し、要求は送らない", async () => {
    const sent = stubFetch(async (body) => okResponse(body.import_id));
    const s = screen();

    await click(s.add());
    expect(sent).toHaveLength(0);
    expect(s.text()).toContain("1 行目");
  });
});

describe("タブの往復", () => {
  it("応答が消えたあとに画面を切り替えても、内容と import_id を保ったまま再送できる", async () => {
    const sent = lostThenOk();
    const s = screen();
    await fillCard(s, "invoice", "請求書");

    await click(s.add());
    expect(s.text()).toContain("もう一度送れる");

    // 貼り付け取り込みを覗いて戻ってくる。
    await s.toPaste();
    await type(s.paste(), "ledger\t元帳");
    await s.toSingle();

    expect(s.front().value).toBe("invoice");
    expect(s.back().value).toBe("請求書");

    await click(s.add());
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual(sent[1]);

    // 貼り付け側の入力も残っている。
    await s.toPaste();
    expect(s.paste().value).toBe("ledger\t元帳");
  });

  it("送信中に画面を切り替えても、戻ったときに結果が出ている", async () => {
    const pending = deferred();
    const sent = stubFetch(async () => await pending.promise);
    const s = screen();
    await fillCard(s, "invoice", "請求書");

    await click(s.add());
    await s.toPaste();
    expect(s.text()).not.toContain("追加 1 件");

    pending.resolve(okResponse(sent[0]?.import_id ?? ""));
    await flush();

    await s.toSingle();
    expect(s.text()).toContain("追加 1 件");
    expect(sent).toHaveLength(1);
  });
});

describe("貼り付け取り込みの画面", () => {
  it("プレビューしてから取り込む。応答が消えても同じ import_id で再送できる", async () => {
    const sent = lostThenOk();
    const s = screen();
    await s.toPaste();

    await type(s.paste(), "invoice\t請求書\nledger\t元帳");
    await click(buttonByText(s.root, "プレビュー"));
    expect(s.text()).toContain("TSV(タブ区切り)");
    expect(s.text()).toContain("1. invoice — 請求書");

    await click(buttonByText(s.root, "2 件を取り込む"));
    expect(s.text()).toContain("もう一度送れる");
    // 入力とプレビューは残っているので、そのまま押し直せる。
    expect(s.paste().value).toBe("invoice\t請求書\nledger\t元帳");

    await click(buttonByText(s.root, "2 件を取り込む"));
    expect(sent).toHaveLength(2);
    expect(sent[0]?.import_id).toBe(sent[1]?.import_id);
    expect(sent[0]?.cards).toHaveLength(2);
    expect(sent[0]).toEqual(sent[1]);
    // 取り込めたら入力とプレビューを片付ける。
    expect(s.paste().value).toBe("");
    expect(s.text()).not.toContain("2 件を取り込む");
  });

  it("プレビューのあとに本文を変えると、取り込む前にプレビューし直させる", async () => {
    const sent = stubFetch(async (body) => okResponse(body.import_id, 2));
    const s = screen();
    await s.toPaste();

    await type(s.paste(), "invoice\t請求書");
    await click(buttonByText(s.root, "プレビュー"));
    expect(s.text()).toContain("1 件を取り込む");

    await type(s.paste(), "invoice\t請求書\nledger\t元帳");
    expect(s.text()).toContain("もう一度プレビュー");
    expect(s.text()).not.toContain("1 件を取り込む");
    expect(sent).toHaveLength(0);

    await click(buttonByText(s.root, "プレビュー"));
    await click(buttonByText(s.root, "2 件を取り込む"));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.cards).toHaveLength(2);
  });

  it("無効な行があるプレビューからは取り込めない", async () => {
    const sent = stubFetch(async (body) => okResponse(body.import_id));
    const s = screen();
    await s.toPaste();

    await type(s.paste(), "invoice\t請求書\nledger");
    await click(buttonByText(s.root, "プレビュー"));
    expect(s.text()).toContain("無効な行があるので取り込めない");
    expect(buttonByText(s.root, "件を取り込む").disabled).toBe(true);

    await click(buttonByText(s.root, "件を取り込む"));
    expect(sent).toHaveLength(0);
  });

  it("送信中は本文を編集できず、プレビューした内容をそのまま送る", async () => {
    const pending = deferred();
    const sent = stubFetch(async () => await pending.promise);
    const s = screen();
    await s.toPaste();

    await type(s.paste(), "invoice\t請求書");
    await click(buttonByText(s.root, "プレビュー"));
    await click(buttonByText(s.root, "1 件を取り込む"));

    expect(s.paste().disabled).toBe(true);
    await type(s.paste(), "ledger\t元帳");
    expect(s.paste().value).toBe("invoice\t請求書");

    pending.resolve(okResponse(sent[0]?.import_id ?? ""));
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.cards[0]?.front).toBe("invoice");
  });
});
