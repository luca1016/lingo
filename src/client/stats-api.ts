// 統計画面の通信(GET /api/stats)。読むだけなので冪等キーは要らないが、
// 例外は外に出さない(「読み込み中」のまま固まるのを避ける)。失敗は code と文で返し、
// 画面が「再ログインなのか・取り直すのか」を判断できるようにする。

import type { StatsResponse } from "../shared/stats";

/**
 * - `unauthenticated`: 認証切れ(401)。再ログインするまで取り直しても通らない。
 * - `network_error`: 通信できなかった / 応答が読めなかった。取り直せる。
 * - `server_error`: 4xx・5xx など。取り直せる。
 */
export type StatsApiErrorCode = "unauthenticated" | "network_error" | "server_error";

export interface StatsApiError {
  error: StatsApiErrorCode;
  message: string;
}

export type StatsResult =
  | { ok: true; response: StatsResponse }
  | { ok: false; status: number; error: StatsApiError };

/** 認証切れを表す status(worker の accessAuth が API 経路で返す)。 */
const UNAUTHENTICATED = 401;

export async function getStats(): Promise<StatsResult> {
  let res: Response;
  try {
    res = await fetch("/api/stats");
  } catch {
    return {
      ok: false,
      status: 0,
      error: { error: "network_error", message: "通信できなかった" },
    };
  }

  if (res.status === UNAUTHENTICATED) {
    return {
      ok: false,
      status: res.status,
      error: { error: "unauthenticated", message: "ログインの有効期限が切れた" },
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: { error: "server_error", message: `失敗しました(${res.status})` },
    };
  }

  try {
    return { ok: true, response: (await res.json()) as StatsResponse };
  } catch {
    return {
      ok: false,
      status: res.status,
      error: { error: "network_error", message: "応答を読み取れなかった" },
    };
  }
}
