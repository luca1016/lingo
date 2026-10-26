// 復習画面の通信(GET /api/due と POST /api/review)。
// 例外は外に出さない(送信中の表示が解除されないまま固まるのを避ける)。失敗は必ず code と文で返し、
// 画面が「再送できるのか・再ログインなのか・出し直すのか」を判断できるようにする。

import type {
  DueResponse,
  ReviewErrorCode,
  ReviewErrorResponse,
  ReviewRating,
  ReviewResponse,
  ReviewState,
} from "../shared/review";

/**
 * 画面が見る失敗の種類。サーバの 4xx の code に、画面側でしか起きないものを足す。
 * - `unauthenticated`: 認証切れ(401)。再ログインするまで何を送っても通らないので再送しない。
 * - `network_error`: 要求が届いたかどうかも分からない。同じ review_id で再送できる。
 * - `server_error`: 5xx など。同じ review_id で再送できる。
 */
export type ReviewApiErrorCode =
  | ReviewErrorCode
  | "unauthenticated"
  | "network_error"
  | "server_error";

export interface ReviewApiError {
  error: ReviewApiErrorCode;
  message: string;
  /** version_conflict のときだけサーバの今の状態が入る。 */
  state?: ReviewState;
}

export type ApiResult<T> =
  | { ok: true; response: T }
  | { ok: false; status: number; error: ReviewApiError };

/** POST /api/review に送る 1 件(冪等キーつき)。同じ要求の再送はこれをそのまま使い回す。 */
export interface ReviewAttempt {
  reviewId: string;
  cardId: string;
  rating: ReviewRating;
  expectedVersion: number;
  /** 解答した時刻(UTC ISO)。再送でも変えない。 */
  occurredAt: string;
  elapsedMs: number | null;
}

/** 認証切れを表す status(worker の accessAuth が API 経路で返す)。 */
const UNAUTHENTICATED = 401;

/**
 * 別版で弾かれたことを表す status。POST /api/review の失敗のうち、これだけが
 * 「評価は入っていない」と確定できる(ほかは届いたか分からないので同じ review_id で再送する)。
 */
export const CONFLICT = 409;

/** 結果が不明なときの案内(同じ review_id で再送すれば二重には記録されない)。 */
export const RESEND_HINT = "同じ評価をもう一度送れる(二重には記録されない)";

function networkError(message: string): ReviewApiError {
  return { error: "network_error", message };
}

/** 失敗応答の本文を読む(JSON でなければ status だけで説明を作る)。 */
async function errorOf(res: Response): Promise<ReviewApiError> {
  if (res.status === UNAUTHENTICATED) {
    return { error: "unauthenticated", message: "ログインの有効期限が切れた" };
  }
  try {
    const body = (await res.json()) as ReviewErrorResponse;
    if (typeof body?.error === "string") {
      return { error: body.error, message: body.message ?? "", state: body.state };
    }
  } catch {
    // 本文が JSON でない(Access の拒否など)。
  }
  return { error: "server_error", message: `失敗しました(${res.status})` };
}

async function readJson<T>(res: Response, hint = ""): Promise<ApiResult<T>> {
  try {
    return { ok: true, response: (await res.json()) as T };
  } catch {
    // 成功しているかもしれないが結果が読めない。再送すれば同じ結果が返る。
    return {
      ok: false,
      status: res.status,
      error: networkError(`応答を読み取れなかった。${hint}`.trim()),
    };
  }
}

/** GET /api/due。出せるカード(学習中 → 復習 → 新規)を取る。 */
export async function getDue(limit?: number): Promise<ApiResult<DueResponse>> {
  let res: Response;
  try {
    res = await fetch(limit === undefined ? "/api/due" : `/api/due?limit=${limit}`);
  } catch {
    return { ok: false, status: 0, error: networkError("通信できなかった") };
  }
  if (!res.ok) return { ok: false, status: res.status, error: await errorOf(res) };
  return await readJson<DueResponse>(res);
}

/**
 * POST /api/review。同一 Origin + JSON(guard.ts)で送る。
 * review_id は呼び出し側が持っているので、通信に失敗しても同じ要求をそのまま再送できる。
 */
export async function postReview(attempt: ReviewAttempt): Promise<ApiResult<ReviewResponse>> {
  let res: Response;
  try {
    res = await fetch("/api/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        review_id: attempt.reviewId,
        card_id: attempt.cardId,
        rating: attempt.rating,
        expected_version: attempt.expectedVersion,
        occurred_at: attempt.occurredAt,
        elapsed_ms: attempt.elapsedMs,
      }),
    });
  } catch {
    // 要求が届いたかどうかも分からない(オフライン・切断など)。
    return { ok: false, status: 0, error: networkError(`通信できなかった。${RESEND_HINT}`) };
  }
  if (!res.ok) return { ok: false, status: res.status, error: await errorOf(res) };
  return await readJson<ReviewResponse>(res, RESEND_HINT);
}

/** 評価 1 件の冪等キー。1 回の送信ごとに作り、再送では作り直さない。 */
export function newReviewId(): string {
  return crypto.randomUUID();
}
