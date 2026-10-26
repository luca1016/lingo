// 復習画面の状態機械(見た目は Review.tsx、通信は review-api.ts)。
//
// 画面の状態は 1 つの reducer(`reduce`)だけが動かす。状態は次の 6 つで、どの action を
// 受け付けるかはその状態だけで決まる(個別の経路を塞ぐのではなく、形で守る)。
//
//   idle       … 出せるカードが無い(短期カードの待ち)。期限が来たら showing に入る
//   loading    … 出すものが無いまま取得を待っている
//   showing    … 1 枚を出している(めくる前・めくった後)。card_id で固定する
//   sending    … 評価 1 件(attempt)を送っている
//   unresolved … 送ったが結果が分からない。同じ attempt の再送でしか抜けられない
//   done       … 出すカードが無い(待ちも無い)
//
// attempt = review_id / card_id / expected_version / rating の組(= 冪等キーと前提)。
// 再送は同じ attempt をそのまま送るので、サーバには 1 回分しか入らない。
//
// 不変条件:
//  A. sending / unresolved の間は、他のカードの評価・待ち行列の差し替え・表示カードの変更を
//     すべて拒否する。できるのは「同じ attempt の再送」と「取得で確定済みか見ること」だけ。
//  B. 取得(GET /api/due)の応答は sending / unresolved 中は反映せず `pending` に保留し、
//     attempt が確定してから反映する。出している 1 枚は、期限の到来や新しい due の出現では
//     入れ替わらない(入れ替わるのは評価が確定したときだけ)。
//  C. attempt の確定は「200(成功または冪等)」か「409 / 404(別版・消失 → 取り直して出し直す)」
//     だけ。通信失敗は unresolved に移り、ユーザーの操作で再送する。
//
// 取得には世代番号(`generation`)を付ける。応答が返った時点で最新世代でなければ捨てる。
// 世代は状態が持つので、タブを往復して画面が作り直されても続く。確定より前に始まった取得も
// 「古い応答」なので、確定の時点で世代を進めて無効にする(評価前の版に巻き戻さない)。

import {
  type DueCard,
  queueOfFsrsState,
  type ReviewRating,
  type ReviewState,
} from "../shared/review";
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

/** 画面の状態(状態機械の状態)。 */
export type Phase =
  | { kind: "idle" }
  | { kind: "loading" }
  /** 出している 1 枚。`revealedAt` が null ならまだ表だけ。 */
  | { kind: "showing"; cardId: string; revealedAt: number | null }
  | { kind: "sending"; attempt: ReviewAttempt }
  | { kind: "unresolved"; attempt: ReviewAttempt; reason: string }
  | { kind: "done" };

/** sending / unresolved 中に返ってきた取得。attempt が確定してから反映する(不変条件 B)。 */
export interface PendingDue {
  cards: DueCard[];
  newRemaining: number;
}

export interface Session {
  /** いまの状態。これだけで受け付ける操作が決まる。 */
  phase: Phase;
  /** 残っているカード(この中から 1 枚出す)。 */
  queue: QueuedCard[];
  /** 取得(GET /api/due)が進行中か。重ねて出さないための印。 */
  fetching: boolean;
  /** 取得の世代(直近に始めた取得の番号。0 = まだ取得していない)。 */
  generation: number;
  /** 保留している取得の応答。 */
  pending: PendingDue | null;
  /** 認証切れ。立ったら以後どの action も受け付けない(再送ループを作らない)。 */
  authExpired: boolean;
  /** 取得の失敗(取り直せる)。 */
  failure: string | null;
  /** 出し直したときなどの案内(失敗ではない)。 */
  notice: string | null;
  /** その日あと何枚の新規を出せるか(未取得なら null)。 */
  newRemaining: number | null;
}

/** 状態機械に流す出来事。 */
export type Action =
  /** 取得を始める(`force` = 画面を開き直したので進行中でも取り直す)。 */
  | { type: "load_started"; force: boolean; notice: string | null }
  | {
      type: "load_succeeded";
      generation: number;
      cards: readonly DueCard[];
      newRemaining: number;
      now: number;
    }
  | { type: "load_failed"; generation: number; failure: string }
  /** 認証切れ。取得由来なら世代を付ける(古い応答では落とさない)。 */
  | { type: "auth_expired"; generation: number | null }
  | { type: "reveal"; cardId: string; now: number }
  | { type: "send_started"; attempt: ReviewAttempt }
  | { type: "send_resolved"; attempt: ReviewAttempt; state: ReviewState; now: number }
  | { type: "send_conflicted"; attempt: ReviewAttempt }
  | { type: "send_unresolved"; attempt: ReviewAttempt; reason: string }
  /** 時計が進んだ(期限の来た短期カードを出す)。 */
  | { type: "tick"; now: number };

/** 画面の状態を更新する(いまの状態から次を作る。古い値を抱えたまま上書きしないため)。 */
export type SetSession = (update: (prev: Session) => Session) => void;

export function newSession(): Session {
  return {
    // 開いた直後に「いま出すカードは無い」と出さないため、最初の取得を待つ状態で始める。
    phase: { kind: "loading" },
    queue: [],
    fetching: false,
    generation: 0,
    pending: null,
    authExpired: false,
    failure: null,
    notice: null,
    newRemaining: null,
  };
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
 * (取り直したときに、待っている短期カードの待ち時間表示を失わないため)。
 */
export function mergeQueue(
  previous: readonly QueuedCard[],
  cards: readonly DueCard[],
  now: number,
): QueuedCard[] {
  const fromServer = cards.map(toQueued);
  const ids = new Set(fromServer.map((q) => q.cardId));
  const waiting = previous.filter((q) => !ids.has(q.cardId) && Date.parse(q.due) > now);
  return [...fromServer, ...waiting];
}

/** 期限が来ているもののうち、期限がいちばん早い 1 枚(無ければ null)。 */
function earliestDue(queue: readonly QueuedCard[], now: number): QueuedCard | null {
  let earliest: QueuedCard | null = null;
  for (const q of queue) {
    const due = Date.parse(q.due);
    if (due > now) continue;
    if (earliest === null || due < Date.parse(earliest.due)) earliest = q;
  }
  return earliest;
}

/**
 * 待ち行列から次の状態を決める(評価が確定したとき・取り直したときだけ呼ぶ)。
 * 期限が来ている 1 枚を出し、無ければ待ち(idle)、待ちも無ければ終わり(done)。
 */
function settle(queue: readonly QueuedCard[], now: number): Phase {
  if (queue.length === 0) return { kind: "done" };
  const next = earliestDue(queue, now);
  return next ? { kind: "showing", cardId: next.cardId, revealedAt: null } : { kind: "idle" };
}

/**
 * attempt が確定したときの、進行中の取得の扱い(不変条件 B)。
 * 確定より前に始まった取得の応答は「評価前のサーバの状態」なので、反映すると確定した
 * version / due が巻き戻る。世代を進めて無効にし、代わりに取り直す(呼び出し側が `loadDue`)。
 */
function invalidateFetch(session: Session): { fetching: boolean; generation: number } {
  return {
    fetching: false,
    generation: session.fetching ? session.generation + 1 : session.generation,
  };
}

/** attempt の結果を待っているか(= 他の操作をすべて拒否する。不変条件 A)。 */
function awaitingAttempt(phase: Phase): boolean {
  return phase.kind === "sending" || phase.kind === "unresolved";
}

/** その action が指す attempt が、いま送っている 1 件か。 */
function isSending(phase: Phase, attempt: ReviewAttempt): boolean {
  return phase.kind === "sending" && phase.attempt.reviewId === attempt.reviewId;
}

/**
 * 状態機械。拒否する action では同じ参照をそのまま返す(呼び出し側が受理されたか分かる)。
 */
export function reduce(session: Session, action: Action): Session {
  // 認証切れのあとは何も動かさない(送信も取得も再送もしない)。
  if (session.authExpired) return session;

  switch (action.type) {
    case "load_started":
      return startLoad(session, action.force, action.notice);
    case "load_succeeded":
      return applyDue(session, action);
    case "load_failed":
      return failLoad(session, action.generation, action.failure);
    case "auth_expired":
      if (action.generation !== null && action.generation !== session.generation) return session;
      return {
        ...session,
        authExpired: true,
        fetching: false,
        pending: null,
        phase: { kind: "idle" },
        failure: null,
        notice: null,
      };
    case "reveal":
      return revealCard(session, action.cardId, action.now);
    case "send_started":
      return startSend(session, action.attempt);
    case "send_resolved":
      return resolveSend(session, action);
    case "send_conflicted":
      return conflictSend(session, action.attempt);
    case "send_unresolved":
      if (!isSending(session.phase, action.attempt)) return session;
      return {
        ...session,
        phase: { kind: "unresolved", attempt: action.attempt, reason: action.reason },
      };
    case "tick":
      return tick(session, action.now);
  }
}

/**
 * 取得を始める。
 * - 送信中は取りに行かない(結果は POST の応答で決まる)。
 * - 取得中に重ねて呼ばれても GET は増やさない。画面を開き直したときだけ取り直す(`force`)。
 *   そのとき進行中だった取得は世代が合わなくなるので、応答が返っても捨てられる。
 * - 出している 1 枚と未確定の 1 件は取得で消さない(不変条件 A・B)。
 */
function startLoad(session: Session, force: boolean, notice: string | null): Session {
  if (session.phase.kind === "sending") return session;
  if (session.fetching && !force) return session;
  const keep = session.phase.kind === "showing" || session.phase.kind === "unresolved";
  return {
    ...session,
    phase: keep ? session.phase : { kind: "loading" },
    fetching: true,
    generation: session.generation + 1,
    failure: null,
    notice,
  };
}

/** 取り直した結果を反映する(送信中・未確定なら保留する)。 */
function applyDue(
  session: Session,
  action: { generation: number; cards: readonly DueCard[]; newRemaining: number; now: number },
): Session {
  // 自分より後に始まった取得があれば、この応答は古い。何も書かない。
  if (action.generation !== session.generation) return session;
  if (awaitingAttempt(session.phase)) {
    // 不変条件 B: 捨てずに保留し、attempt が確定してから反映する。
    return {
      ...session,
      fetching: false,
      pending: { cards: [...action.cards], newRemaining: action.newRemaining },
    };
  }
  const queue = mergeQueue(session.queue, action.cards, action.now);
  return {
    ...session,
    fetching: false,
    failure: null,
    queue,
    newRemaining: action.newRemaining,
    // 出している 1 枚が残っていればそのまま出し続ける(不変条件 B)。
    phase: keepShowing(session.phase, queue) ?? settle(queue, action.now),
  };
}

function keepShowing(phase: Phase, queue: readonly QueuedCard[]): Phase | null {
  if (phase.kind !== "showing") return null;
  return queue.some((q) => q.cardId === phase.cardId) ? phase : null;
}

function failLoad(session: Session, generation: number, failure: string): Session {
  if (generation !== session.generation) return session;
  // 送信中・未確定のときの取得は「確定済みか見る」ためのものなので、失敗しても画面は変えない。
  if (awaitingAttempt(session.phase)) return { ...session, fetching: false };
  return {
    ...session,
    fetching: false,
    failure,
    // 取れなかっただけなので「出すカードは無い」とは言わない(理由と取り直しを出す)。
    phase: session.phase.kind === "loading" ? { kind: "idle" } : session.phase,
  };
}

/** 出している 1 枚の裏をめくる(そのカードを出していないときは何もしない)。 */
function revealCard(session: Session, cardId: string, now: number): Session {
  const phase = session.phase;
  if (phase.kind !== "showing" || phase.cardId !== cardId || phase.revealedAt !== null) {
    return session;
  }
  if (!session.queue.some((q) => q.cardId === cardId)) return session;
  return { ...session, phase: { ...phase, revealedAt: now } };
}

/**
 * 評価 1 件を送り始める。
 * 未確定の 1 件があるあいだは、同じ attempt の再送だけ受け付ける(不変条件 A)。
 * それ以外は「めくって出している 1 枚」で、手元の version のままのときだけ送れる。
 */
function startSend(session: Session, attempt: ReviewAttempt): Session {
  const phase = session.phase;
  if (phase.kind === "unresolved") {
    if (phase.attempt.reviewId !== attempt.reviewId) return session;
    return { ...session, phase: { kind: "sending", attempt: phase.attempt } };
  }
  if (phase.kind !== "showing" || phase.revealedAt === null) return session;
  if (phase.cardId !== attempt.cardId) return session;
  const sendable = session.queue.some(
    (q) => q.cardId === attempt.cardId && q.version === attempt.expectedVersion,
  );
  if (!sendable) return session;
  return { ...session, phase: { kind: "sending", attempt }, failure: null, notice: null };
}

/**
 * 200(成功または冪等)で確定した。評価した 1 枚を待ち行列から外し、
 * 短期カード(学習ステップ)なら待ち時間つきで戻す。保留していた取得はここで反映する。
 */
function resolveSend(
  session: Session,
  action: { attempt: ReviewAttempt; state: ReviewState; now: number },
): Session {
  if (!isSending(session.phase, action.attempt)) return session;
  const cardId = action.attempt.cardId;
  const reviewed = session.queue.find((q) => q.cardId === cardId);
  const rest = session.queue.filter((q) => q.cardId !== cardId);
  const shortTerm =
    queueOfFsrsState(action.state.fsrs_state) === "learning" &&
    Date.parse(action.state.due) - action.now <= SHORT_TERM_WAIT_MAX_MS;
  // 保留していた応答は、この確定より前にサーバが見た内容。評価した 1 枚については
  // いま確定した version / due のほうが新しいので、サーバ側の古い 1 枚は入れない。
  const pending = session.pending;
  const merged = pending
    ? mergeQueue(
        rest,
        pending.cards.filter((c) => c.card_id !== cardId),
        action.now,
      )
    : rest;
  // 短期カードは確定した version / due で戻す。再送が期限を過ぎてから確定することもあるので、
  // 期限では絞らない(ここで落とすと、サーバがまだ出していないそのカードは出番を失う)。
  const queue =
    reviewed && shortTerm
      ? [...merged, { ...reviewed, version: action.state.version, due: action.state.due }]
      : merged;
  return {
    ...session,
    ...invalidateFetch(session),
    queue,
    pending: null,
    newRemaining: pending ? pending.newRemaining : session.newRemaining,
    failure: null,
    notice: null,
    phase: settle(queue, action.now),
  };
}

/**
 * 409(別版)・404(消えた)で確定した。手元の version が古いと分かったので、
 * そのカードは落として取り直す(呼び出し側が `loadDue` する)。
 * 保留していた応答・進行中の取得もこの確定より前の内容なので使わない。
 */
function conflictSend(session: Session, attempt: ReviewAttempt): Session {
  if (!isSending(session.phase, attempt)) return session;
  return {
    ...session,
    ...invalidateFetch(session),
    queue: session.queue.filter((q) => q.cardId !== attempt.cardId),
    pending: null,
    phase: { kind: "idle" },
    failure: null,
  };
}

/** 期限が来た短期カードを出す。出している・送っている間は何もしない(不変条件 B)。 */
function tick(session: Session, now: number): Session {
  if (session.phase.kind !== "idle") return session;
  const next = earliestDue(session.queue, now);
  if (!next) return session;
  return { ...session, phase: { kind: "showing", cardId: next.cardId, revealedAt: null } };
}

// --- 画面が読む値 ---

function shownCardId(phase: Phase): string | null {
  if (phase.kind === "showing") return phase.cardId;
  if (phase.kind === "sending" || phase.kind === "unresolved") return phase.attempt.cardId;
  return null;
}

/** いま出している 1 枚(出していなければ null)。どのカードかは状態が持つ card_id で決まる。 */
export function currentCard(session: Session): QueuedCard | null {
  const cardId = shownCardId(session.phase);
  if (cardId === null) return null;
  return session.queue.find((q) => q.cardId === cardId) ?? null;
}

/** 裏を出しているか(めくった後・送信中・未確定)。 */
export function isRevealed(session: Session): boolean {
  const phase = session.phase;
  if (phase.kind === "showing") return phase.revealedAt !== null;
  return awaitingAttempt(phase);
}

/** 送信中(ボタンは全部無効)。 */
export function isSendingNow(session: Session): boolean {
  return session.phase.kind === "sending";
}

/** 結果が分からない 1 件(同じ attempt の再送でしか抜けられない)。 */
export function unresolved(session: Session): { attempt: ReviewAttempt; reason: string } | null {
  return session.phase.kind === "unresolved" ? session.phase : null;
}

/** その評価を押せるか(送信中は不可。未確定なら同じ attempt の再送だけ)。 */
export function canRate(session: Session, rating: ReviewRating): boolean {
  const phase = session.phase;
  if (phase.kind === "unresolved") return phase.attempt.rating === rating;
  return phase.kind === "showing" && phase.revealedAt !== null;
}

/** 出せるカードが無いとき、次に出せる時刻(= 短期カードの待ち)。 */
export function nextDueAt(session: Session, now: Date): Date | null {
  if (session.phase.kind !== "idle") return null;
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

// --- 通信(状態機械に action を流すだけ) ---

function describe(error: ReviewApiError): string {
  return `${error.message}(${error.error})`;
}

/** その失敗は同じ attempt で再送できるか(= 結果が分からない)。 */
function resendable(error: ReviewApiError): boolean {
  return error.error === "network_error" || error.error === "server_error";
}

/**
 * action を 1 つ流す。更新関数が見た状態(`before`)と結果(`after`)を返すので、
 * 受理されたか(`before !== after`)と、続きで使う最新の状態が分かる。
 */
function dispatch(
  set: SetSession,
  snapshot: Session,
  action: Action,
): { before: Session; after: Session } {
  let before = snapshot;
  let after = reduce(snapshot, action);
  set((prev) => {
    before = prev;
    after = reduce(prev, action);
    return after;
  });
  return { before, after };
}

/**
 * due を取り直す(初回・409・手動・画面を開き直したとき)。
 * 受け付けるかどうかは状態機械が決める(認証切れ・送信中・取得中は何もしない)。
 */
export async function loadDue(
  session: Session,
  set: SetSession,
  options: { notice?: string | null; force?: boolean } = {},
): Promise<void> {
  const started = dispatch(set, session, {
    type: "load_started",
    force: options.force === true,
    notice: options.notice ?? null,
  });
  if (started.after === started.before) return;
  const generation = started.after.generation;

  const res = await getDue();
  const now = Date.now();
  if (!res.ok) {
    if (res.error.error === "unauthenticated") {
      dispatch(set, started.after, { type: "auth_expired", generation });
      return;
    }
    dispatch(set, started.after, { type: "load_failed", generation, failure: describe(res.error) });
    return;
  }
  dispatch(set, started.after, {
    type: "load_succeeded",
    generation,
    cards: res.response.cards,
    newRemaining: res.response.new_remaining,
    now,
  });
}

/**
 * 出している 1 枚に評価をつける。
 * 未確定の 1 件があるあいだは、同じカード・同じ評価(= 同じ attempt)の押し直しだけが通り、
 * それは再送になる(新しい review_id は作らない)。
 */
export async function rate(
  session: Session,
  card: QueuedCard,
  rating: ReviewRating,
  set: SetSession,
  now: Date = new Date(),
): Promise<void> {
  const held = unresolved(session);
  if (held) {
    if (held.attempt.cardId === card.cardId && held.attempt.rating === rating) {
      await send(session, held.attempt, set);
    }
    return;
  }
  const phase = session.phase;
  if (phase.kind !== "showing" || phase.revealedAt === null) return;
  await send(
    session,
    {
      reviewId: newReviewId(),
      cardId: card.cardId,
      rating,
      expectedVersion: card.version,
      occurredAt: now.toISOString(),
      elapsedMs: Math.max(0, now.getTime() - phase.revealedAt),
    },
    set,
  );
}

/** 結果が分からない 1 件を、そのまま(同じ review_id で)送り直す。 */
export async function resend(session: Session, set: SetSession): Promise<void> {
  const held = unresolved(session);
  if (held) await send(session, held.attempt, set);
}

async function send(session: Session, attempt: ReviewAttempt, set: SetSession): Promise<void> {
  const started = dispatch(set, session, { type: "send_started", attempt });
  if (started.after === started.before) return;
  const sending = started.after;

  try {
    const res = await postReview(attempt);
    if (res.ok) {
      const resolved = dispatch(set, sending, {
        type: "send_resolved",
        attempt,
        state: res.response.state,
        now: Date.now(),
      });
      // 確定より前に始まっていた取得は無効にしたので、代わりにここで取り直す。
      if (resolved.after !== resolved.before && resolved.before.fetching) {
        await loadDue(resolved.after, set, { force: true });
      }
      return;
    }
    if (res.error.error === "unauthenticated") {
      dispatch(set, sending, { type: "auth_expired", generation: null });
      return;
    }
    if (resendable(res.error)) {
      dispatch(set, sending, { type: "send_unresolved", attempt, reason: describe(res.error) });
      return;
    }
    // 409(別版)・404(消えた)はここで確定。最新を取り直して出し直す(不変条件 C)。
    // 進行中の古い取得に任せず force で取り直す(その応答は手元の確定より前の内容)。
    const conflicted = dispatch(set, sending, { type: "send_conflicted", attempt });
    await loadDue(conflicted.after, set, {
      notice: `出し直した(${describe(res.error)})`,
      force: true,
    });
  } catch (cause) {
    // postReview は例外を出さない作りだが、万一出ても送信中のまま固まらせない。
    dispatch(set, sending, {
      type: "send_unresolved",
      attempt,
      reason: `送信できなかった(${String(cause)})。${RESEND_HINT}`,
    });
  }
}
