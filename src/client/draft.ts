// 画面の「送信草稿」= 入力内容と冪等キー(import_id)を一組にして持つ状態と、その遷移。
// 単票追加と貼り付け取り込みの両方がこれを使う(画面の状態遷移はここだけに書き、単体テストする)。
//
// 守りたいこと:
//  - import_id は「いま入力されている内容」に対してだけ有効。内容を変えたら必ず新しい import_id にする
//    (応答が消えたあとに内容を変えて再送すると、サーバは冪等に前回の結果を返すので、
//     変更が保存されていないのに成功したように見えてしまう)。
//  - 応答が不明(通信エラー)のときは、内容を変えずにそのまま再送できる(同じ import_id = 増えない)。
//  - 送信中は編集を受け付けない(送信した内容と import_id の組が崩れる・完了時に編集が消えるのを防ぐ)。

import type { ImportResponse, NormalizedCard, RowError } from "../shared/cards";
import { newImportId, postCards } from "./api";

/** 画面の入力内容(単票なら front/back/example/note、貼り付けなら text の 1 項目)。 */
export type DraftContent = Record<string, string>;

export interface Draft {
  /** いま入力されている内容。 */
  content: DraftContent;
  /** content と一組の冪等キー。content が変われば必ず新しくなる。 */
  importId: string;
  /** 送信中(このあいだ編集は受け付けない)。 */
  sending: boolean;
  /** 送信できなかった・4xx だったときの説明。 */
  failure: string | null;
  /** 4xx の行別エラー。 */
  errors: RowError[];
  /** 直前の取り込み結果(内容を変えても消さない。消すのは次の送信を始めるとき)。 */
  result: ImportResponse | null;
}

/** import_id を作る関数(テストでは固定の採番に差し替える)。 */
export type MintId = () => string;

/** 内容が同じか(空文字と未設定は同じものとして見る)。 */
export function sameContent(a: DraftContent, b: DraftContent): boolean {
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if ((a[key] ?? "") !== (b[key] ?? "")) return false;
  }
  return true;
}

export function newDraft(content: DraftContent, mint: MintId = newImportId): Draft {
  return { content, importId: mint(), sending: false, failure: null, errors: [], result: null };
}

/**
 * 入力を書き換える。送信中は何もしない(画面側も入力を disabled にする)。
 * 内容が変わったときだけ新しい import_id を割り当て、前回の失敗表示も捨てる。
 */
export function editDraft(draft: Draft, content: DraftContent, mint: MintId = newImportId): Draft {
  if (draft.sending) return draft;
  if (sameContent(draft.content, content)) return { ...draft, content };
  return { ...draft, content, importId: mint(), failure: null, errors: [] };
}

/**
 * 送信が終わったあと、次の入力に移る(内容が変わるので import_id も新しくする)。
 * 直前の結果表示(result)は残す。
 */
export function resetDraft(draft: Draft, content: DraftContent, mint: MintId = newImportId): Draft {
  if (draft.sending) return draft;
  return { ...draft, content, importId: mint(), failure: null, errors: [] };
}

/** 入力を編集できないか(= 送信中)。画面の disabled はこれで決める。 */
export function isLocked(draft: Draft): boolean {
  return draft.sending;
}

/**
 * 草稿の内容を POST /api/cards に送る。成功したら true。
 * 失敗したときは content と import_id をそのまま残すので、同じ組でそのまま再送できる。
 */
export async function submitDraft(
  draft: Draft,
  cards: readonly NormalizedCard[],
  setDraft: (next: Draft) => void,
): Promise<boolean> {
  const sending: Draft = { ...draft, sending: true, failure: null, errors: [], result: null };
  setDraft(sending);
  const done = (patch: Partial<Draft>): Draft => ({ ...sending, sending: false, ...patch });
  try {
    const res = await postCards(draft.importId, cards);
    if (res.ok) {
      setDraft(done({ result: res.response }));
      return true;
    }
    setDraft(
      done({
        failure: `${res.error.message}(${res.error.error})`,
        errors: res.error.errors ?? [],
      }),
    );
  } catch (cause) {
    // postCards は例外を出さない作りだが、万一出ても送信中のまま固まらせない。
    setDraft(done({ failure: `送信できなかった(${String(cause)})` }));
  }
  return false;
}
