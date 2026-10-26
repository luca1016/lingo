// 復習画面の状態と遷移(画面の見た目は Review.tsx、通信は review-api.ts)。
//
// 守りたいこと:
//  - 冪等キー(review_id)は「このカード・この評価・この version」に対してだけ有効。
//    同じものを押し直した再送は同じ review_id で送り(二重評価にならない)、
//    別の評価に変えたら新しい review_id にする(サーバが前回の結果を返して誤解させないため)。
//  - 送信中は何も受け付けない(ボタンは disabled。サーバ側冪等性の補助)。
//  - 409(version_conflict)は端末の持っている version が古いだけなので、due を取り直して続ける。
//  - 認証切れ(401)はログインし直すまで何を送っても通らないので、再送をやめて案内だけ出す。
//  - 短期カード(学習ステップ)は due を手元に持ち、時間が来たら同じ画面で出し直す。
//  - 取得(GET /api/due)には世代番号を付け、応答が返った時点で最新世代でなければ結果を捨てる。
//    画面の状態は「いまの状態(prev)」から作り直す(更新関数で渡す)ので、遅れて返ってきた取得が
//    送信状態・再送キー・短期カードを巻き戻すことがない。

import { type DueCard, queueOfFsrsState, type ReviewRating } from "../shared/review";
import {
  getDue,
  newReviewId,
  postReview,
  RESEND_HINT,
  type ReviewApiError,
  type ReviewAttempt,
} from "./review-api";

/**
 * 「短期カード」とみなす待ち時間の上限。learning / relearning で次の期限がこれ以内なら、
 * 画面に残して待ち時間を出す(既定の学習ステップは 1m・10m)。
 * これより先のものはサーバの GET /api/due が期限到来後に出すので手元には持たない。
 */
export const SHORT_TERM_WAIT_MAX_MS = 60 * 60 * 1000;

/**
 * 出題待ちの 1 枚。`due` を過ぎるまでは出さない(短期カードの待ち)。
 * `version` と `due` は評価するたびに進むので、表示する中身とは分けて持つ
 * (DueCard をそのまま抱えると、中の version / due が古いまま残る)。
 */
export interface QueuedCard {
  cardId: string;
  front: string;
  back: string;
  example: string | null;
  note: string | null;
  /** 次に送る expected_version。 */
  version: number;
  /** これ以降に出せる(UTC ISO)。 */
  due: string;
}

export interface Session {
  /** 残っているカード(先頭から見て、出せるものを 1 枚出す)。 */
  queue: QueuedCard[];
  /** 裏までめくったか。 */
  revealed: boolean;
  /** めくった時刻(ms)。評価までの時間を elapsed_ms に入れる。 */
  revealedAt: number | null;
  /** 送信中。 */
  sending: boolean;
  /** 送った(送ろうとした)1 件。失敗しても残すので同じ review_id で再送できる。 */
  attempt: ReviewAttempt | null;
  /** 再送できる失敗の説明。 */
  failure: string | null;
  /** 認証切れ。立ったら送信も取得もしない。 */
  authExpired: boolean;
  /** GET /api/due 中。 */
  loading: boolean;
  /** 出し直したときなどの案内(失敗ではない)。 */
  notice: string | null;
  /** その日あと何枚の新規を出せるか(未取得なら null)。 */
  newRemaining: number | null;
  /**
   * いまの状態を作った取得の世代(`loadDue` のたびに 1 つ進む。0 = まだ取得していない)。
   * 応答が返った時点でこれが自分の世代でなければ、新しい取得が始まっているので結果は捨てる。
   */
  generation: number;
}

/** 画面の状態を更新する(いまの状態から次を作る。古い値を抱えたまま上書きしないため)。 */
export type SetSession = (update: (prev: Session) => Session) => void;

export function newSession(): Session {
  return {
    queue: [],
    revealed: false,
    revealedAt: null,
    sending: false,
    attempt: null,
    failure: null,
    authExpired: false,
    loading: false,
    notice: null,
    newRemaining: null,
    generation: 0,
  };
}

/**
 * 取得に付ける世代番号を作る(単調増加。同じ番号は二度出ない)。
 * 画面を作り直しても(タブの往復で Review が再マウントされても)番号は続くので、
 * 前の画面が出した取得の応答が後から返っても「古い」と分かる。
 */
let lastGeneration = 0;
function nextGeneration(): number {
  lastGeneration += 1;
  return lastGeneration;
}

function toQueued(card: DueCard): QueuedCard {
  return {
    cardId: card.card_id,
    front: card.front,
    back: card.back,
    example: card.example,
    note: card.note,
    version: card.version,
    due: card.due,
  };
}

/**
 * 取り直した due と手元の待ち行列を合わせる。
 * サーバが出したものを正とし、手元にしかない「まだ期限が来ていない短期カード」だけ後ろに残す
 * (409 で出し直したときに、待っている短期カードの待ち時間表示を失わないため)。
 *
 * `pendingCardId` は結果が未確定の 1 枚(送ったが応答が消えた)。期限を過ぎていても外さない:
 * 評価が届いていた場合、サーバはもう期限前のカードとして出さないので、ここで落とすと同じ
 * review_id での再送先も待ち時間表示も失う。結果を確定してから `advance` が片付ける。
 */
export function mergeQueue(
  previous: readonly QueuedCard[],
  cards: readonly DueCard[],
  now: Date,
  pendingCardId: string | null = null,
): QueuedCard[] {
  const fromServer = cards.map(toQueued);
  const ids = new Set(fromServer.map((q) => q.cardId));
  const waiting = previous.filter(
    (q) => !ids.has(q.cardId) && (q.cardId === pendingCardId || Date.parse(q.due) > now.getTime()),
  );
  return [...fromServer, ...waiting];
}

/** いま出せるカード(先頭から見て期限が来ている最初の 1 枚)。無ければ null。 */
export function currentCard(session: Session, now: Date): QueuedCard | null {
  return session.queue.find((q) => Date.parse(q.due) <= now.getTime()) ?? null;
}

/** 出せるカードが無いとき、次に出せる時刻(= 短期カードの待ち)。 */
export function nextDueAt(session: Session, now: Date): Date | null {
  if (currentCard(session, now)) return null;
  const times = session.queue.map((q) => Date.parse(q.due));
  return times.length > 0 ? new Date(Math.min(...times)) : null;
}

/** 残り枚数(待っている短期カードも数える)。 */
export function remaining(session: Session): number {
  return session.queue.length;
}

/** 待ち時間の表示(「1 分 5 秒」)。切り上げて 0 秒とは出さない。 */
export function formatWait(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
}

/** 裏をめくる(送信中・認証切れのときは何もしない)。 */
export function reveal(session: Session, now: Date = new Date()): Session {
  if (session.sending || session.authExpired || session.revealed) return session;
  return { ...session, revealed: true, revealedAt: now.getTime() };
}

/** めくってから評価までの時間(測れなければ null)。 */
function elapsedMsOf(session: Session, now: Date): number | null {
  if (session.revealedAt === null) return null;
  return Math.max(0, now.getTime() - session.revealedAt);
}

/** その失敗は同じ review_id で再送できるか。 */
function resendable(error: ReviewApiError): boolean {
  return error.error === "network_error" || error.error === "server_error";
}

/** 認証切れになった画面(送信もしないし、再送ボタンも出さない)。 */
function expired(session: Session): Session {
  return {
    ...session,
    sending: false,
    loading: false,
    authExpired: true,
    failure: null,
    notice: null,
  };
}

/**
 * due を取り直す(初回・409・手動)。手元の待ち行列のうち、まだ期限が来ていない短期カードは残す。
 * 認証切れのあとは何もしない(再送ループを作らない)。
 *
 * 送信中は取り直さない(POST と GET を同時に走らせない)。送信の結果はその応答で決まるので、
 * 並行して始めた GET が後から返って送信後の状態を上書きし、通信中でないのにボタンが無効のまま
 * 残る、ということが起きないようにする(タブを往復すると再マウントでここに来る)。
 *
 * 取得中に重ねて呼ばれても GET は出さない(進行中の 1 件に任せる)。画面を開き直したときだけは
 * `force` で取り直す(離れている間にサーバ側が変わっている)。そのとき進行中だった古い取得は
 * 世代が合わなくなるので、応答が返っても捨てられる。
 */
export async function loadDue(
  session: Session,
  set: SetSession,
  options: { notice?: string | null; now?: Date; force?: boolean } = {},
): Promise<void> {
  if (session.authExpired || session.sending) return;
  if (session.loading && !options.force) return;
  const now = options.now ?? new Date();
  const generation = nextGeneration();
  set((prev) => ({
    ...prev,
    loading: true,
    generation,
    // 結果が未確定の 1 件(attempt)とその説明は捨てない。同じ review_id で再送して確定できるように。
    failure: prev.attempt ? prev.failure : null,
    notice: options.notice ?? null,
  }));

  const res = await getDue();
  // 自分より後に始まった取得があれば、この応答は古い。画面には何も書かない。
  const ifLatest = (apply: (prev: Session) => Session): void => {
    set((prev) => (prev.generation === generation ? apply(prev) : prev));
  };
  if (!res.ok) {
    if (res.error.error === "unauthenticated") return ifLatest(expired);
    return ifLatest((prev) => ({ ...prev, loading: false, failure: describe(res.error) }));
  }
  ifLatest((prev) => ({
    ...prev,
    loading: false,
    queue: mergeQueue(prev.queue, res.response.cards, now, prev.attempt?.cardId ?? null),
    revealed: false,
    revealedAt: null,
    newRemaining: res.response.new_remaining,
  }));
}

function describe(error: ReviewApiError): string {
  return `${error.message}(${error.error})`;
}

/** 同じ要求(カード・評価・前提の version が同じ)の再送なら、1 回目の review_id を使い回す。 */
function attemptFor(session: Session, card: QueuedCard, rating: ReviewRating, now: Date) {
  const previous = session.attempt;
  if (
    previous &&
    previous.cardId === card.cardId &&
    previous.rating === rating &&
    previous.expectedVersion === card.version
  ) {
    return previous;
  }
  return {
    reviewId: newReviewId(),
    cardId: card.cardId,
    rating,
    expectedVersion: card.version,
    occurredAt: now.toISOString(),
    elapsedMs: elapsedMsOf(session, now),
  } satisfies ReviewAttempt;
}

/**
 * いま出ている 1 枚に評価をつけて確定する。同じ評価を押し直した再送は同じ review_id で送る。
 * 対象のカードは画面が見ているものをそのまま受け取る(時計のずれで別の 1 枚を送らないため)。
 */
export async function rate(
  session: Session,
  card: QueuedCard,
  rating: ReviewRating,
  set: SetSession,
  now: Date = new Date(),
): Promise<void> {
  if (session.sending || session.loading || session.authExpired || !session.revealed) return;
  const inQueue = session.queue.some((q) => q.cardId === card.cardId && q.version === card.version);
  if (!inQueue) return;
  await send(session, attemptFor(session, card, rating, now), set, now);
}

/** 失敗した 1 件をそのまま(同じ review_id で)送り直す。 */
export async function resend(session: Session, set: SetSession, now: Date = new Date()) {
  // 取り直しの最中も送らない(GET と POST を同時に走らせない)。
  if (session.sending || session.loading || session.authExpired || !session.attempt) return;
  await send(session, session.attempt, set, now);
}

async function send(
  session: Session,
  attempt: ReviewAttempt,
  set: SetSession,
  now: Date,
): Promise<void> {
  set((prev) => ({ ...prev, sending: true, attempt, failure: null, notice: null }));

  try {
    const res = await postReview(attempt);
    if (res.ok) {
      set((prev) => advance(prev, attempt.cardId, res.response.state, now));
      return;
    }
    if (res.error.error === "unauthenticated") return set(expired);
    if (resendable(res.error)) {
      set((prev) => ({ ...prev, sending: false, failure: describe(res.error) }));
      return;
    }
    // 409(別の評価で先に進んでいた)や 404(消えた)は手元が古いだけ。出し直して続ける。
    // 送った 1 件はもう再送しない(サーバの状態が違う)ので、ここで捨ててから取り直す。
    set((prev) => ({ ...prev, sending: false, attempt: null }));
    await loadDue({ ...session, sending: false, loading: false, attempt: null }, set, {
      notice: `出し直した(${describe(res.error)})`,
      now,
    });
  } catch (cause) {
    // postReview は例外を出さない作りだが、万一出ても送信中のまま固まらせない。
    set((prev) => ({
      ...prev,
      sending: false,
      failure: `送信できなかった(${String(cause)})。${RESEND_HINT}`,
    }));
  }
}

/** 確定した 1 枚を待ち行列から外す。短期カード(学習ステップ)なら待ち時間つきで戻す。 */
function advance(
  session: Session,
  cardId: string,
  state: { due: string; version: number; fsrs_state: number },
  now: Date,
): Session {
  const reviewed = session.queue.find((q) => q.cardId === cardId);
  const rest = session.queue.filter((q) => q.cardId !== cardId);
  const shortTerm =
    queueOfFsrsState(state.fsrs_state) === "learning" &&
    Date.parse(state.due) - now.getTime() <= SHORT_TERM_WAIT_MAX_MS;
  return {
    ...session,
    queue:
      reviewed && shortTerm
        ? [...rest, { ...reviewed, version: state.version, due: state.due }]
        : rest,
    revealed: false,
    revealedAt: null,
    sending: false,
    attempt: null,
    failure: null,
    notice: null,
  };
}
