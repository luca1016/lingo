// 復習画面の状態機械(src/client/review.ts の `reduce`)の単体テスト。
// 設計書の遷移表をそのまま押さえる(実 API・実画面を通した流れは review-screen.test.ts)。
//
//  - サーバーが唯一の正。持つのは current(表示中の 1 枚)と attempt(未確定の送信 1 件)だけ
//  - current がある間、GET の応答は反映しない(中身を捨てる)
//  - attempt がある間できるのは再送だけ
//
// 表に無い組み合わせは「無視」= 同じ参照を返すので、`toBe` で押さえる。

import { describe, expect, it } from "vitest";
import { type Event, initialSession, reduce, type Session, unresolved } from "../src/client/review";
import type { ReviewAttempt } from "../src/client/review-api";
import type { DueCard, DueResponse, ReviewRating } from "../src/shared/review";

const NOW = Date.parse("2026-10-26T01:23:45.000Z");
const MINUTE = 60 * 1000;

function iso(at: number): string {
  return new Date(at).toISOString();
}

function dueCard(cardId: string, over: Partial<DueCard> = {}): DueCard {
  return {
    card_id: cardId,
    front: cardId,
    back: `${cardId} の意味`,
    example: null,
    note: null,
    due: iso(NOW - MINUTE),
    version: 1,
    fsrs_state: 0,
    queue: "new",
    reps: 0,
    lapses: 0,
    ...over,
  };
}

function dueResponse(cards: DueCard[], nextDueAt: string | null = null): DueResponse {
  return {
    now: iso(NOW),
    limit: 20,
    cards,
    next_due_at: nextDueAt,
    new_today: 0,
    new_remaining: 20,
  };
}

function attemptFor(cardId: string, rating: ReviewRating = 1, version = 1): ReviewAttempt {
  return {
    review_id: `review-${cardId}-${rating}-${version}`,
    card_id: cardId,
    rating,
    expected_version: version,
    occurred_at: iso(NOW),
    elapsed_ms: 1000,
  };
}

const ATTEMPT = attemptFor("A");

/** NEXT → GET_OK を 1 往復させる。 */
function load(session: Session, response: DueResponse): Session {
  const started = reduce(session, { type: "NEXT" });
  expect(started.fetch.inflight).toBe(true);
  return reduce(started, { type: "GET_OK", gen: started.fetch.gen, response });
}

/** A を出している状態。 */
function showing(cards: DueCard[] = [dueCard("A"), dueCard("B")]): Session {
  const session = load(initialSession(), dueResponse(cards));
  expect(session.current?.card.card_id).toBe("A");
  return session;
}

/** A をめくって Again を送り始めた状態。 */
function sending(): Session {
  const revealed = reduce(showing(), { type: "REVEAL", now: NOW });
  const next = reduce(revealed, { type: "RATE", attempt: ATTEMPT });
  expect(next.attempt).toMatchObject({ phase: "sending", review_id: ATTEMPT.review_id });
  return next;
}

/** 送ったが結果が分からない状態。 */
function unresolvedSession(): Session {
  const next = reduce(sending(), {
    type: "POST_FAILED",
    reviewId: ATTEMPT.review_id,
    message: "通信できなかった",
  });
  expect(unresolved(next)).toMatchObject({ review_id: ATTEMPT.review_id });
  return next;
}

/** どの出来事でも状態が 1 ミリも動かないこと。 */
function ignoresAll(session: Session, events: readonly Event[]): void {
  for (const event of events) {
    expect(reduce(session, event), event.type).toBe(session);
  }
}

describe("復習の状態機械(取得)", () => {
  it("NEXT で世代を進めて取得に入り、応答の 1 枚目を出す", () => {
    const session = showing();
    expect(session.fetch).toEqual({ gen: 1, inflight: false });
    expect(session.current).toEqual({ card: dueCard("A"), version: 1 });
    expect(session.revealedAt).toBeNull();
    expect(session.remaining).toBe(2);
    expect(session.newRemaining).toBe(20);
    expect(session.waitUntil).toBeNull();
  });

  it("取得中は重ねて NEXT を出さない(世代も使わない)", () => {
    const started = reduce(initialSession(), { type: "NEXT" });
    expect(started.fetch).toEqual({ gen: 1, inflight: true });
    ignoresAll(started, [{ type: "NEXT" }]);
  });

  it("空の応答は next_due_at を待ち時間にする(無ければ今日は完了)", () => {
    const waiting = load(initialSession(), dueResponse([], iso(NOW + MINUTE)));
    expect(waiting.current).toBeNull();
    expect(waiting.waitUntil).toBe(iso(NOW + MINUTE));
    expect(waiting.remaining).toBe(0);

    const done = load(initialSession(), dueResponse([]));
    expect(done.waitUntil).toBeNull();
  });

  it("世代が合わない応答は何も動かさない", () => {
    const started = reduce(initialSession(), { type: "NEXT" });
    const stale = started.fetch.gen - 1;
    ignoresAll(started, [
      { type: "GET_OK", gen: stale, response: dueResponse([dueCard("A")]) },
      { type: "GET_FAILED", gen: stale, message: "通信できなかった" },
      { type: "GET_UNAUTHENTICATED", gen: stale },
    ]);
  });

  it("current があるあいだは応答の中身を捨てる(表示中のカードは切り替わらない)", () => {
    const session = showing();
    const started = reduce(session, { type: "NEXT" });
    // current があるので NEXT 自体が無視される(GET は出ない)。
    expect(started).toBe(session);

    // それでも応答が届いたら(行き違い)、進行中の印を下ろすだけで中身は入れない。
    const applied = reduce(session, {
      type: "GET_OK",
      gen: session.fetch.gen,
      response: dueResponse([dueCard("B")], iso(NOW + MINUTE)),
    });
    expect(applied.current).toBe(session.current);
    expect(applied.waitUntil).toBeNull();
    expect(applied.remaining).toBe(2);
  });

  it("取得に失敗したら「無い」とは言わず、理由を出す", () => {
    const started = reduce(initialSession(), { type: "NEXT" });
    const failed = reduce(started, {
      type: "GET_FAILED",
      gen: started.fetch.gen,
      message: "通信できなかった",
    });
    expect(failed.fetchError).toBe("通信できなかった");
    expect(failed.fetch.inflight).toBe(false);
    expect(failed.current).toBeNull();
    expect(failed.waitUntil).toBeNull();

    // 取り直せる(次の NEXT で世代が進む)。
    expect(reduce(failed, { type: "NEXT" }).fetch).toEqual({ gen: 2, inflight: true });
  });

  it("取得が認証切れなら、以後 NEXT を受け付けない(再送ループを作らない)", () => {
    const started = reduce(initialSession(), { type: "NEXT" });
    const expired = reduce(started, { type: "GET_UNAUTHENTICATED", gen: started.fetch.gen });
    expect(expired.authExpired).toBe(true);
    expect(expired.fetch.inflight).toBe(false);
    ignoresAll(expired, [{ type: "NEXT" }, { type: "RATE", attempt: ATTEMPT }]);
  });
});

describe("復習の状態機械(めくる・評価)", () => {
  it("めくれるのは表示中の 1 枚だけで、めくり直しても時刻は動かない", () => {
    const session = showing();
    const revealed = reduce(session, { type: "REVEAL", now: NOW });
    expect(revealed.revealedAt).toBe(NOW);
    ignoresAll(revealed, [{ type: "REVEAL", now: NOW + 1000 }]);
    // 出していないあいだはめくれない。
    ignoresAll(load(initialSession(), dueResponse([])), [{ type: "REVEAL", now: NOW }]);
  });

  it("送れるのは、めくった表示中の 1 枚とその版だけ", () => {
    ignoresAll(showing(), [{ type: "RATE", attempt: ATTEMPT }]); // めくる前
    const revealed = reduce(showing(), { type: "REVEAL", now: NOW });
    ignoresAll(revealed, [
      { type: "RATE", attempt: attemptFor("B") }, // 出していないカード
      { type: "RATE", attempt: attemptFor("A", 1, 5) }, // 別の版
    ]);
    expect(reduce(revealed, { type: "RATE", attempt: ATTEMPT }).attempt).toEqual({
      ...ATTEMPT,
      phase: "sending",
    });
  });

  it("送信中は、別の評価・めくり直し・取得をすべて拒否する", () => {
    ignoresAll(sending(), [
      { type: "RATE", attempt: attemptFor("A", 3) },
      { type: "RATE", attempt: attemptFor("B") },
      { type: "REVEAL", now: NOW },
      { type: "NEXT" },
      { type: "RESEND" },
      // 行き違いの応答(別の review_id)では動かない。
      { type: "POST_200", reviewId: "other" },
      { type: "POST_409", reviewId: "other" },
      { type: "POST_FAILED", reviewId: "other", message: "x" },
      { type: "POST_401", reviewId: "other", message: "x" },
    ]);
  });

  it("200 / 409 だけが確定で、確定したら取り直しに入る", () => {
    for (const event of [
      { type: "POST_200", reviewId: ATTEMPT.review_id },
      { type: "POST_409", reviewId: ATTEMPT.review_id },
    ] as const) {
      const resolved = reduce(sending(), event);
      expect(resolved.attempt).toBeNull();
      expect(resolved.current).toBeNull();
      expect(resolved.revealedAt).toBeNull();
      // 次の NEXT で訊き直せる(手元にカードを残さない)。
      expect(reduce(resolved, { type: "NEXT" }).fetch.inflight).toBe(true);
    }
  });

  it("それ以外の応答は確定させず、未確定(error)にする", () => {
    const held = unresolvedSession();
    expect(held.attempt).toMatchObject({
      ...ATTEMPT,
      phase: "unresolved",
      reason: { kind: "error", message: "通信できなかった" },
    });
    // 表示中の 1 枚はそのまま(再送先が分かるように残す)。
    expect(held.current?.card.card_id).toBe("A");
  });

  it("未確定のあいだできるのは、同じ attempt の再送だけ", () => {
    const held = unresolvedSession();
    ignoresAll(held, [
      { type: "RATE", attempt: attemptFor("A", 3) }, // 評価を変える
      { type: "RATE", attempt: attemptFor("B") }, // 別のカード
      { type: "REVEAL", now: NOW },
      { type: "NEXT" }, // タブ復帰・待ち時間の到来も含む
      // 再送して 200 / 409 を受けるまでは確定しない。
      { type: "POST_200", reviewId: ATTEMPT.review_id },
      { type: "POST_409", reviewId: ATTEMPT.review_id },
    ]);

    const resent = reduce(held, { type: "RESEND" });
    expect(resent.attempt).toEqual({ ...ATTEMPT, phase: "sending", reason: undefined });
    // 再送で 200(冪等)なら確定して次へ。
    expect(reduce(resent, { type: "POST_200", reviewId: ATTEMPT.review_id }).attempt).toBeNull();
  });

  it("未確定のあいだに届いた応答も、中身は捨てる(保留して後から入れたりしない)", () => {
    const held = unresolvedSession();
    const applied = reduce(held, {
      type: "GET_OK",
      gen: held.fetch.gen,
      response: dueResponse([dueCard("B")], iso(NOW + MINUTE)),
    });
    expect(applied.current).toBe(held.current);
    expect(applied.attempt).toBe(held.attempt);
    expect(applied.waitUntil).toBeNull();
    expect(applied.remaining).toBe(2);
  });

  it("送信が認証切れなら未確定(auth)で、再送は error と同じ扱い", () => {
    const expired = reduce(sending(), {
      type: "POST_401",
      reviewId: ATTEMPT.review_id,
      message: "ログインの有効期限が切れた",
    });
    expect(expired.attempt).toMatchObject({ phase: "unresolved", reason: { kind: "auth" } });
    // 勝手に送り直さない(取得も評価も受け付けない)。動くのは人が押した RESEND だけ。
    ignoresAll(expired, [{ type: "NEXT" }, { type: "RATE", attempt: ATTEMPT }]);

    // ログインし直したあと、同じ review_id・同じ expected_version で送り直せる。
    const resent = reduce(expired, { type: "RESEND" });
    expect(resent.attempt).toEqual({ ...ATTEMPT, phase: "sending", reason: undefined });
    expect(reduce(resent, { type: "POST_200", reviewId: ATTEMPT.review_id }).attempt).toBeNull();
  });
});
