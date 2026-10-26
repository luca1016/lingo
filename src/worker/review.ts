import type { Handler } from "hono";
import {
  DUE_QUEUES,
  type DueCard,
  type DueResponse,
  parseDueLimit,
  parseReviewRequest,
  queueOfFsrsState,
  type ReviewErrorCode,
  type ReviewErrorResponse,
  type ReviewRequest,
  type ReviewResponse,
  type ReviewState,
} from "../shared/review";
import type { AccessVariables } from "./access";
import {
  type CardStateRow,
  commitReview,
  countNewStartedBetween,
  type DueCardRow,
  getCard,
  getCardState,
  getReview,
  getSettings,
  listDueCards,
  type ReviewRow,
} from "./db";
import { applyReview, toReviewState } from "./fsrs";
import { dayWindow, toUtcIso } from "./time";

type AppEnv = { Bindings: Env; Variables: AccessVariables };

function failure(
  error: ReviewErrorCode,
  message: string,
  state?: ReviewState,
): ReviewErrorResponse {
  return state ? { error, message, state } : { error, message };
}

function toDueCard(row: DueCardRow): DueCard {
  return {
    card_id: row.card_id,
    front: row.front,
    back: row.back,
    example: row.example,
    note: row.note,
    due: row.due,
    version: row.version,
    fsrs_state: row.fsrs_state,
    queue: queueOfFsrsState(row.fsrs_state),
    reps: row.reps,
    lapses: row.lapses,
  };
}

/**
 * GET /api/due — これから出すカード。
 *
 * 学習中で期限到来 → 復習で期限到来 → 新規(その日の残り上限分)の順に、`limit` 枚まで返す。
 * 各カードには card_state の現在の `version` が入る(そのまま POST /api/review の `expected_version`)。
 * 「その日」の境界は settings の timezone(既定 Asia/Tokyo)で決める。保存値は UTC のまま。
 */
export const getDue: Handler<AppEnv> = async (c) => {
  const limit = parseDueLimit(c.req.query("limit"));
  if (limit === null) {
    return c.json(failure("invalid_limit", "limit は 1 以上の整数で送る"), 400);
  }

  const now = new Date();
  const settings = await getSettings(c.env.DB);
  const today = dayWindow(now, settings.timezone);
  const newToday = await countNewStartedBetween(c.env.DB, today.start, today.end);
  const newRemaining = Math.max(0, settings.newCardsPerDay - newToday);

  const cards: DueCard[] = [];
  for (const queue of DUE_QUEUES) {
    const room = limit - cards.length;
    if (room <= 0) break;
    const take = queue === "new" ? Math.min(room, newRemaining) : room;
    const rows = await listDueCards(c.env.DB, { queue, now, limit: take });
    cards.push(...rows.map(toDueCard));
  }

  const response: DueResponse = {
    now: toUtcIso(now),
    limit,
    cards,
    new_today: newToday,
    new_remaining: newRemaining,
  };
  return c.json(response);
};

/** 応答は 1 回目も再送も必ずここで作る(同じ材料から同じ本文になる)。 */
function reviewResponse(params: {
  reviewId: string;
  cardId: string;
  rating: number;
  occurredAt: string;
  stateAfter: CardStateRow;
}): ReviewResponse {
  return {
    review_id: params.reviewId,
    card_id: params.cardId,
    rating: params.rating,
    occurred_at: params.occurredAt,
    state: toReviewState(params.stateAfter),
  };
}

/** 保存済みの行から応答を作り直す(再送に返す)。 */
function replayResponse(row: ReviewRow): ReviewResponse {
  return reviewResponse({
    reviewId: row.review_id,
    cardId: row.card_id,
    rating: row.rating,
    occurredAt: row.occurred_at,
    stateAfter: JSON.parse(row.state_after) as CardStateRow,
  });
}

/**
 * POST /api/review — 評価を 1 件確定する。
 *
 * - `review_id` で冪等。同じ id の再送には 1 回目とまったく同じ応答を返し、reviews も state も変えない
 *   (同時送信で 1 回目が途中に割り込んだ場合も、409 ではなく 1 回目の結果を返す)。
 * - `expected_version` が今の card_state.version と違えば 409(何も変えない)。
 * - 成功時は 1 つの batch で「reviews の INSERT + 条件付き UPDATE」を流し、UPDATE が 0 件なら 409。
 * - FSRS の計算は純関数(`applyReview`)に任せ、ここは HTTP と D1 の面倒だけを見る。
 */
export const postReview: Handler<AppEnv> = async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(failure("invalid_json", "本文が JSON ではない"), 400);
  }

  const parsed = parseReviewRequest(body);
  if (!parsed.request) return c.json(failure(parsed.error.code, parsed.error.message), 400);
  const request: ReviewRequest = parsed.request;

  // 再送なら 1 回目の結果をそのまま返す(計算も書き込みもしない)。
  const replayed = await getReview(c.env.DB, request.review_id);
  if (replayed) return c.json(replayResponse(replayed), 200);

  const card = await getCard(c.env.DB, request.card_id);
  if (!card) return c.json(failure("card_not_found", "そのカードは無い"), 404);
  const state = await getCardState(c.env.DB, request.card_id);
  if (!state) return c.json(failure("card_not_found", "そのカードの FSRS 状態が無い"), 404);

  if (state.version !== request.expected_version) {
    // ログを引いてから state を読むまでに、同じ review_id の 1 回目が確定していることがある。
    // その場合は version のずれではなく再送なので、1 回目の結果を返す。
    const raced = await getReview(c.env.DB, request.review_id);
    if (raced) return c.json(replayResponse(raced), 200);
    return c.json(conflict(state), 409);
  }

  const settings = await getSettings(c.env.DB);
  const receivedAt = new Date();
  const applied = applyReview({
    state,
    rating: request.rating,
    occurredAt: request.occurred_at,
    receivedAt,
    parameters: settings.fsrs,
  });

  const committed = await commitReview(c.env.DB, {
    review: {
      review_id: request.review_id,
      card_id: request.card_id,
      rating: request.rating,
      occurred_at: request.occurred_at,
      received_at: receivedAt,
      elapsed_ms: request.elapsed_ms,
      state_before: applied.state_before,
      state_after: applied.state_after,
      review_log: applied.review_log,
      fsrs_version: applied.fsrs_version,
      params_version: settings.paramsVersion,
    },
    next: applied.state_after,
    expectedVersion: state.version,
  });

  if (!committed) {
    // 読んでから書くまでに割り込まれた。同じ review_id が先に入っていたなら、それが 1 回目。
    const raced = await getReview(c.env.DB, request.review_id);
    if (raced) return c.json(replayResponse(raced), 200);
    const current = await getCardState(c.env.DB, request.card_id);
    return c.json(conflict(current ?? state), 409);
  }

  return c.json(
    reviewResponse({
      reviewId: request.review_id,
      cardId: request.card_id,
      rating: request.rating,
      occurredAt: toUtcIso(request.occurred_at),
      stateAfter: applied.state_after,
    }),
    200,
  );
};

/** 409 の本文。サーバ側の今の状態を添えて、画面が出し直せるようにする。 */
function conflict(current: CardStateRow): ReviewErrorResponse {
  return failure(
    "version_conflict",
    `このカードは別の評価で更新されている(今の version は ${current.version})`,
    toReviewState(current),
  );
}
