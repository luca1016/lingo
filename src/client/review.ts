// 復習画面の状態(設計書 §4・§6 Issue 4 の遷移表をそのまま実装する)。
//
// 原則:
//  - **サーバーが唯一の正**。手元に持つのは `current`(表示中の 1 枚)と `attempt`(未確定の送信 1 件)
//    だけで、カードのキューは持たない。取得の結果を手元の並びに合成することはしない。
//  - **`current` がある間、GET の応答は一切反映しない**(中身は捨てる)。`current` が変わるのは
//    評価が確定したときだけ(期限の到来や新しい due の出現では切り替わらない)。
//  - **`attempt` がある間できるのは「再送」だけ**。別カードの評価・取得・タブ復帰での差し替えは無効。
//  - 状態はコンポーネントではなくこのモジュールのストアに置くので、アンマウント / 再マウントで
//    失われない(タブを往復しても送信状態と再送キーがそのまま残る)。
//
// 遷移表(状態 × イベント → 次状態 / 副作用。表に無い組み合わせは無視 = 同じ参照を返す):
//
//   current=null, attempt=null │ NEXT              │ gen++ して GET /api/due(inflight 中は無視)
//   current=null, attempt=null │ GET_OK(非空・gen 一致) │ current = cards[0]、未めくり
//   current=null, attempt=null │ GET_OK(空・gen 一致)  │ waitUntil = next_due_at(無ければ null)
//   any                        │ gen 不一致 / current≠null / attempt≠null の GET 応答 │ 中身を捨てる
//   current≠null, attempt=null │ REVEAL            │ 裏を出す
//   current≠null, 裏, attempt=null │ RATE(r)       │ attempt = {新 review_id, …, sending} → POST
//   attempt.sending            │ POST_200 / POST_409 │ attempt=null, current=null → NEXT
//   attempt.sending            │ POST_401          │ unresolved(auth)。再ログイン表示
//   attempt.sending            │ それ以外すべて      │ unresolved(error)。再送の導線を出す
//   attempt.unresolved         │ RESEND            │ 同じ review_id / expected_version で POST
//   attempt≠null               │ RATE / NEXT / タイマー / タブ復帰 │ 無視
//   current≠null               │ タイマー(waitUntil)│ 無視(表示中のカードは切り替えない)

import type { DueCard, DueResponse, ReviewRating } from "../shared/review";
import {
  CONFLICT,
  getDue,
  newReviewId,
  postReview,
  RESEND_HINT,
  type ReviewApiError,
  type ReviewAttempt,
} from "./review-api";

/** 未確定の送信が確定しなかった理由(`auth` = 認証切れ、`error` = 結果が分からない)。 */
export interface AttemptFailure {
  kind: "auth" | "error";
  message: string;
}

/**
 * 送信 1 件。`review_id` と `expected_version` は再送でも作り直さない(= 冪等キーと前提)。
 * `phase` が `unresolved` のあいだは、この 1 件の再送以外に何もできない。
 */
export interface Attempt extends ReviewAttempt {
  phase: "sending" | "unresolved";
  reason?: AttemptFailure;
}

/** 表示中の 1 枚。`version` をそのまま POST の `expected_version` に使う。 */
export interface Current {
  card: DueCard;
  version: number;
}

export interface Session {
  current: Current | null;
  /** めくった時刻(null = まだ表だけ)。遷移表の `revealed` で、`elapsed_ms` の計測も兼ねる。 */
  revealedAt: number | null;
  attempt: Attempt | null;
  /** 取得の世代と進行中かどうか(古い応答を捨て、重ねて GET を出さないため)。 */
  fetch: { gen: number; inflight: boolean };
  /** 出せるカードが無いとき、次に due が来る時刻(応答の `next_due_at`。null = 今日は完了)。 */
  waitUntil: string | null;
  /** 直近に反映した GET の枚数と新規の残り(表示用。カードそのものは持たない)。 */
  remaining: number | null;
  newRemaining: number | null;
  /** 取得が失敗した理由(取り直せる)。 */
  fetchError: string | null;
  /** 取得が認証切れで弾かれた。再ログインの案内だけを出す(取り直さない)。 */
  authExpired: boolean;
}

/** 状態機械に流す出来事。 */
export type Event =
  | { type: "NEXT" }
  | { type: "GET_OK"; gen: number; response: DueResponse }
  | { type: "GET_FAILED"; gen: number; message: string }
  | { type: "GET_UNAUTHENTICATED"; gen: number }
  | { type: "REVEAL"; now: number }
  | { type: "RATE"; attempt: ReviewAttempt }
  | { type: "POST_200"; reviewId: string }
  | { type: "POST_409"; reviewId: string }
  | { type: "POST_401"; reviewId: string; message: string }
  | { type: "POST_FAILED"; reviewId: string; message: string }
  | { type: "RESEND" };

export function initialSession(): Session {
  return {
    current: null,
    revealedAt: null,
    attempt: null,
    fetch: { gen: 0, inflight: false },
    waitUntil: null,
    remaining: null,
    newRemaining: null,
    fetchError: null,
    authExpired: false,
  };
}

/**
 * 応答を受け取って進行中の印を下ろす。世代が合わなければ null(その応答は無かったものとして扱う)。
 * 中身を反映してよいかは別に見る(`current` / `attempt` があるあいだは捨てる)。
 */
function settleFetch(session: Session, gen: number): Session | null {
  if (gen !== session.fetch.gen) return null;
  return { ...session, fetch: { ...session.fetch, inflight: false } };
}

/** 送っている 1 件が、その応答の相手か(行き違いの応答で状態を動かさない)。 */
function sendingAttempt(session: Session, reviewId: string): Attempt | null {
  const attempt = session.attempt;
  if (!attempt || attempt.phase !== "sending") return null;
  return attempt.review_id === reviewId ? attempt : null;
}

/**
 * 状態機械。拒否する出来事では同じ参照をそのまま返す(呼び出し側が受理されたか分かる)。
 */
export function reduce(session: Session, event: Event): Session {
  switch (event.type) {
    case "NEXT": {
      // 表示中の 1 枚と未確定の 1 件があるあいだは訊きに行かない(取得で差し替えないため)。
      // 取得中なら重ねて出さない(進行中の 1 本をそのまま待つ)。
      if (session.authExpired || session.current || session.attempt) return session;
      if (session.fetch.inflight) return session;
      return {
        ...session,
        fetch: { gen: session.fetch.gen + 1, inflight: true },
        fetchError: null,
      };
    }
    case "GET_OK": {
      const settled = settleFetch(session, event.gen);
      if (settled === null) return session;
      // current / attempt があるあいだは応答を反映しない(捨てる)。
      if (session.current || session.attempt) return settled;
      const card = event.response.cards[0];
      if (card === undefined) {
        return {
          ...settled,
          waitUntil: event.response.next_due_at,
          remaining: 0,
          newRemaining: event.response.new_remaining,
          fetchError: null,
        };
      }
      return {
        ...settled,
        current: { card, version: card.version },
        revealedAt: null,
        waitUntil: null,
        remaining: event.response.cards.length,
        newRemaining: event.response.new_remaining,
        fetchError: null,
      };
    }
    case "GET_FAILED": {
      const settled = settleFetch(session, event.gen);
      if (settled === null) return session;
      if (session.current || session.attempt) return settled;
      // 取れなかっただけなので「出すカードは無い」とは言わない(理由と取り直しを出す)。
      return { ...settled, fetchError: event.message };
    }
    case "GET_UNAUTHENTICATED": {
      const settled = settleFetch(session, event.gen);
      if (settled === null) return session;
      return { ...settled, authExpired: true, fetchError: null };
    }
    case "REVEAL": {
      if (!session.current || session.attempt || session.revealedAt !== null) return session;
      return { ...session, revealedAt: event.now };
    }
    case "RATE": {
      if (session.authExpired || session.attempt) return session;
      const current = session.current;
      if (!current || session.revealedAt === null) return session;
      // 表示中の 1 枚と、その版に対する評価だけ送れる。
      if (event.attempt.card_id !== current.card.card_id) return session;
      if (event.attempt.expected_version !== current.version) return session;
      return { ...session, attempt: { ...event.attempt, phase: "sending" } };
    }
    case "RESEND": {
      const attempt = session.attempt;
      if (!attempt || attempt.phase !== "unresolved") return session;
      // 認証切れは再ログインするまで何を送っても通らないので、再送しない(再送ループを作らない)。
      if (attempt.reason?.kind === "auth") return session;
      return { ...session, attempt: { ...attempt, phase: "sending", reason: undefined } };
    }
    case "POST_200":
    case "POST_409": {
      // ここだけが確定(200 = 成功か冪等、409 = サーバーが進んでいる)。どちらも取り直す。
      if (!sendingAttempt(session, event.reviewId)) return session;
      return {
        ...session,
        attempt: null,
        current: null,
        revealedAt: null,
        waitUntil: null,
        fetchError: null,
      };
    }
    case "POST_401": {
      const attempt = sendingAttempt(session, event.reviewId);
      if (!attempt) return session;
      return {
        ...session,
        attempt: {
          ...attempt,
          phase: "unresolved",
          reason: { kind: "auth", message: event.message },
        },
      };
    }
    case "POST_FAILED": {
      const attempt = sendingAttempt(session, event.reviewId);
      if (!attempt) return session;
      return {
        ...session,
        attempt: {
          ...attempt,
          phase: "unresolved",
          reason: { kind: "error", message: event.message },
        },
      };
    }
  }
}

// --- ストア(画面の外に置く。再マウントで失われない) ---

let session: Session = initialSession();
const listeners = new Set<() => void>();

export function getSession(): Session {
  return session;
}

/** 状態が変わったら呼ばれる(画面の購読)。戻り値を呼ぶと購読をやめる。 */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** ストアを初期状態に戻す(テストが前の状態を持ち越さないため。画面からは呼ばない)。 */
export function resetSession(): void {
  session = initialSession();
  for (const listener of [...listeners]) listener();
}

/** 出来事を 1 つ流す。受理されたら true(拒否なら状態は 1 ミリも動かない)。 */
function emit(event: Event): boolean {
  const before = session;
  session = reduce(session, event);
  if (session === before) return false;
  for (const listener of [...listeners]) listener();
  return true;
}

// --- 通信(状態機械に出来事を流すだけ) ---

function describe(error: ReviewApiError): string {
  return `${error.message}(${error.error})`;
}

/**
 * 次の 1 枚をサーバーに訊く(画面を開いたとき・評価の確定後・待ち時間の到来・取り直し)。
 * 表示中の 1 枚・未確定の 1 件・取得中のときは何もしない(状態機械が決める)。
 */
export async function next(): Promise<void> {
  if (!emit({ type: "NEXT" })) return;
  const gen = session.fetch.gen;
  const res = await getDue();
  if (!res.ok) {
    if (res.error.error === "unauthenticated") emit({ type: "GET_UNAUTHENTICATED", gen });
    else emit({ type: "GET_FAILED", gen, message: describe(res.error) });
    return;
  }
  emit({ type: "GET_OK", gen, response: res.response });
}

/** 裏を出す。 */
export function reveal(now: number = Date.now()): void {
  emit({ type: "REVEAL", now });
}

/** 表示中の 1 枚に評価をつけて送る(新しい `review_id` を作るのはここだけ)。 */
export async function rate(rating: ReviewRating, now: Date = new Date()): Promise<void> {
  const current = session.current;
  const revealedAt = session.revealedAt;
  if (!current || revealedAt === null) return;
  const attempt: ReviewAttempt = {
    review_id: newReviewId(),
    card_id: current.card.card_id,
    rating,
    expected_version: current.version,
    occurred_at: now.toISOString(),
    elapsed_ms: Math.max(0, now.getTime() - revealedAt),
  };
  if (!emit({ type: "RATE", attempt })) return;
  await send(attempt.review_id);
}

/** 結果が分からない 1 件を、そのまま(同じ `review_id`・同じ `expected_version` で)送り直す。 */
export async function resend(): Promise<void> {
  const reviewId = session.attempt?.review_id;
  if (reviewId === undefined) return;
  if (!emit({ type: "RESEND" })) return;
  await send(reviewId);
}

async function send(reviewId: string): Promise<void> {
  const attempt = session.attempt;
  if (!attempt || attempt.review_id !== reviewId) return;

  let result: Awaited<ReturnType<typeof postReview>>;
  try {
    result = await postReview(attempt);
  } catch (cause) {
    // postReview は例外を出さない作りだが、万一出ても送信中のまま固まらせない。
    const message = `送信できなかった(${String(cause)})。${RESEND_HINT}`;
    emit({ type: "POST_FAILED", reviewId, message });
    return;
  }

  if (result.ok) {
    if (emit({ type: "POST_200", reviewId })) await next();
    return;
  }
  if (result.error.error === "unauthenticated") {
    emit({ type: "POST_401", reviewId, message: result.error.message });
    return;
  }
  if (result.status === CONFLICT) {
    if (emit({ type: "POST_409", reviewId })) await next();
    return;
  }
  // 404・400・5xx・タイムアウト・JSON 不正 — 届いたか分からないので確定させない。
  emit({ type: "POST_FAILED", reviewId, message: describe(result.error) });
}

// --- 画面が読む値 ---

/** 送信中(評価ボタンは全部無効)。 */
export function isSending(session: Session): boolean {
  return session.attempt?.phase === "sending";
}

/** 結果が分からない 1 件(同じ attempt の再送でしか抜けられない)。 */
export function unresolved(session: Session): Attempt | null {
  const attempt = session.attempt;
  return attempt && attempt.phase === "unresolved" ? attempt : null;
}

/** 再ログインが必要か(取得が 401 / 送信が 401)。 */
export function needsRelogin(session: Session): boolean {
  return session.authExpired || session.attempt?.reason?.kind === "auth";
}

/** 最初の 1 枚を待っている(出すものが無いまま取得中)。 */
export function isLoading(session: Session): boolean {
  return session.fetch.inflight && session.current === null && session.attempt === null;
}

/** その評価を押せるか(送信中・未確定のあいだはどれも押せない)。 */
export function canRate(session: Session): boolean {
  return session.current !== null && session.revealedAt !== null && session.attempt === null;
}

/** 待ち時間の表示(「1 分 5 秒」)。切り上げて 0 秒とは出さない。 */
export function formatWait(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
}
