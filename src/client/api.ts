import type { ImportErrorResponse, ImportResponse, NormalizedCard } from "../shared/cards";

export type PostCardsResult =
  | { ok: true; response: ImportResponse }
  | { ok: false; status: number; error: ImportErrorResponse };

/** POST /api/cards。同一 Origin + JSON(guard.ts)で送る。import_id は呼び出し側が固定して再送に使う。 */
export async function postCards(
  importId: string,
  cards: readonly NormalizedCard[],
): Promise<PostCardsResult> {
  const res = await fetch("/api/cards", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ import_id: importId, cards }),
  });
  if (res.ok) return { ok: true, response: (await res.json()) as ImportResponse };

  let error: ImportErrorResponse = {
    error: "invalid_json",
    message: `失敗しました(${res.status})`,
  };
  try {
    error = (await res.json()) as ImportErrorResponse;
  } catch {
    // 本文が JSON でない(Access の拒否など)ときは既定のメッセージのまま。
  }
  return { ok: false, status: res.status, error };
}

/** 取り込みの冪等キー。プレビューごとに 1 つ作り、再送でも同じものを使う。 */
export function newImportId(): string {
  return crypto.randomUUID();
}
