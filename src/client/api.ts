import type {
  ImportErrorCode,
  ImportErrorResponse,
  ImportResponse,
  NormalizedCard,
  RowError,
} from "../shared/cards";

/** 画面側でしか起きない失敗(通信そのものの失敗、応答が読めなかった)。サーバは返さない。 */
export type PostCardsErrorCode = ImportErrorCode | "network_error";

/** 画面に出す失敗の中身。サーバの 4xx 本文か、通信・応答解析の失敗。 */
export interface PostCardsError {
  error: PostCardsErrorCode;
  message: string;
  errors?: RowError[];
  limit?: number;
  count?: number;
}

export type PostCardsResult =
  | { ok: true; response: ImportResponse }
  | { ok: false; status: number; error: PostCardsError };

/** 結果が不明なときの案内(同じ import_id で再送すれば増えない)。 */
const RETRY_HINT = "同じ内容のまま、もう一度送れる(重複して増えることはない)";

/**
 * POST /api/cards。同一 Origin + JSON(guard.ts)で送る。import_id は呼び出し側が固定して再送に使う。
 * 例外は外に出さない(送信中の表示が解除されないまま固まるのを避ける)。通信に失敗した場合でも
 * 冪等キーは呼び出し側が持っているので、同じ内容をそのまま再送できる。
 */
export async function postCards(
  importId: string,
  cards: readonly NormalizedCard[],
): Promise<PostCardsResult> {
  let res: Response;
  try {
    res = await fetch("/api/cards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ import_id: importId, cards }),
    });
  } catch {
    // 要求が届いたかどうかも分からない(オフライン・切断など)。
    return {
      ok: false,
      status: 0,
      error: { error: "network_error", message: `通信できなかった。${RETRY_HINT}` },
    };
  }

  if (res.ok) {
    try {
      return { ok: true, response: (await res.json()) as ImportResponse };
    } catch {
      // 取り込みは成功しているかもしれないが結果が読めない。再送すれば同じ結果が返る。
      return {
        ok: false,
        status: res.status,
        error: { error: "network_error", message: `応答を読み取れなかった。${RETRY_HINT}` },
      };
    }
  }

  let error: PostCardsError = {
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
