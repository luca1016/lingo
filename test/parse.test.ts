import { describe, expect, it } from "vitest";
import { detectDelimiter, parseCards, parseDelimited, stripBom } from "../src/client/parse";
import { normalizeRows } from "../src/shared/cards";

const BOM = "﻿";

describe("区切り文字の判定", () => {
  it("タブがあれば TSV、無ければ CSV", () => {
    expect(detectDelimiter("a\tb")).toBe("\t");
    expect(detectDelimiter("a,b")).toBe(",");
  });

  it("引用符の中のカンマ・タブは数えない", () => {
    expect(detectDelimiter('"a,b"\tc')).toBe("\t");
    expect(detectDelimiter('"a\tb",c')).toBe(",");
  });

  it("カンマの数がタブより多くても、列がそろう方(TSV)を採る", () => {
    // TSV の項目の中のカンマは引用しなくてよいので、総数で比べると CSV と誤判定する。
    expect(detectDelimiter("front\tback\ninvoice\t請求書,送り状,インボイス,伝票")).toBe("\t");
  });

  it("項目の中にタブが紛れた CSV は CSV のまま", () => {
    expect(detectDelimiter("front,back\ninvoice,請求\t書")).toBe(",");
  });
});

describe("parseDelimited", () => {
  it("引用符内のカンマを 1 つの項目にする", () => {
    expect(parseDelimited('"a,b",c', ",")).toEqual([["a,b", "c"]]);
  });

  it("引用符内の改行を項目の一部にする(CRLF は LF にそろえる)", () => {
    expect(parseDelimited('"1 行目\n2 行目",back', ",")).toEqual([["1 行目\n2 行目", "back"]]);
    expect(parseDelimited('"1 行目\r\n2 行目",back', ",")).toEqual([["1 行目\n2 行目", "back"]]);
  });

  it('"" は引用符 1 つになる', () => {
    expect(parseDelimited('"say ""hi""",あいさつ', ",")).toEqual([['say "hi"', "あいさつ"]]);
  });

  it("CRLF・CR・LF のどれでも行が切れる", () => {
    expect(parseDelimited("a,b\r\nc,d\ne,f\rg,h", ",")).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
      ["g", "h"],
    ]);
  });

  it("末尾の改行で空行を作らない", () => {
    expect(parseDelimited("a,b\r\n", ",")).toEqual([["a", "b"]]);
  });

  it("空の引用符つき項目を保てる", () => {
    expect(parseDelimited('a,"",c', ",")).toEqual([["a", "", "c"]]);
  });

  it("タブ区切りではカンマが項目の一部になる", () => {
    expect(parseDelimited("invoice\t請求書, 送り状", "\t")).toEqual([
      ["invoice", "請求書, 送り状"],
    ]);
  });
});

describe("stripBom", () => {
  it("先頭の BOM だけを落とす", () => {
    expect(stripBom(`${BOM}front`)).toBe("front");
    expect(stripBom(`front${BOM}`)).toBe(`front${BOM}`);
  });
});

describe("parseCards", () => {
  it("TSV(ヘッダ無し)を位置で読む", () => {
    const result = parseCards("invoice\t請求書\tSend the invoice.\tメモ\nledger\t元帳");
    expect(result.delimiter).toBe("\t");
    expect(result.header).toBeNull();
    expect(result.rows).toEqual([
      { front: "invoice", back: "請求書", example: "Send the invoice.", note: "メモ" },
      { front: "ledger", back: "元帳", example: "", note: "" },
    ]);
  });

  it("CSV のヘッダ行を読み、列の並びに従う", () => {
    const result = parseCards("back,note,front\n請求書,紙でも電子でも,invoice");
    expect(result.header).toEqual(["back", "note", "front"]);
    expect(result.rows).toEqual([
      { front: "invoice", back: "請求書", example: "", note: "紙でも電子でも" },
    ]);
  });

  it("日本語のヘッダ(表 / 裏 / 例文 / メモ)も読む", () => {
    const result = parseCards("表,裏,例文,メモ\ninvoice,請求書,Send it.,A");
    expect(result.header).toEqual(["表", "裏", "例文", "メモ"]);
    expect(result.rows[0]).toEqual({
      front: "invoice",
      back: "請求書",
      example: "Send it.",
      note: "A",
    });
  });

  it("front / back がそろわない 1 行目はヘッダ扱いしない(データとして読む)", () => {
    const result = parseCards("invoice,請求書\nledger,元帳");
    expect(result.header).toBeNull();
    expect(result.rows).toHaveLength(2);
  });

  it("BOM + ヘッダ + CRLF + 引用符内のカンマと改行をまとめて読める", () => {
    const text = `${BOM}front,back,example\r\ninvoice,"請求書, 送り状","Please send\r\nthe invoice."\r\nledger,元帳,\r\n`;
    const result = parseCards(text);
    expect(result.delimiter).toBe(",");
    expect(result.header).toEqual(["front", "back", "example"]);
    expect(result.rows).toEqual([
      { front: "invoice", back: "請求書, 送り状", example: "Please send\nthe invoice.", note: "" },
      { front: "ledger", back: "元帳", example: "", note: "" },
    ]);
  });

  it("項目の中にカンマを複数含む TSV をヘッダごと TSV として読む", () => {
    const result = parseCards(
      "front\tback\ninvoice\t請求書,送り状,インボイス,伝票\nledger\t元帳,帳簿",
    );
    expect(result.delimiter).toBe("\t");
    expect(result.header).toEqual(["front", "back"]);
    expect(result.rows).toEqual([
      { front: "invoice", back: "請求書,送り状,インボイス,伝票", example: "", note: "" },
      { front: "ledger", back: "元帳,帳簿", example: "", note: "" },
    ]);
    expect(normalizeRows(result.rows).errors).toEqual([]);
  });

  it("空行は読み飛ばす", () => {
    const result = parseCards("invoice\t請求書\n\n\nledger\t元帳\n");
    expect(result.rows).toHaveLength(2);
  });

  it("空文字では 1 行も返さない", () => {
    expect(parseCards("").rows).toEqual([]);
    expect(parseCards(`${BOM}\r\n`).rows).toEqual([]);
  });

  it("裏が無い行は検証で無効になる(parser は行を落とさない)", () => {
    const result = parseCards("front,back\ninvoice,\nledger,元帳");
    expect(result.rows).toHaveLength(2);
    const { cards, errors } = normalizeRows(result.rows);
    expect(cards).toHaveLength(1);
    expect(errors).toEqual([
      { row: 1, field: "back", code: "required", message: expect.stringContaining("必須") },
    ]);
  });
});
