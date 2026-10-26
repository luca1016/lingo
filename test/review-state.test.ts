// 復習画面の状態機械(src/client/review.ts の `reduce`)の単体テスト。
// 不変条件を状態機械そのものの上で固定する(実 API・実画面を通した流れは review-screen.test.ts)。
//
//  A: sending / unresolved の間は、他のカードの評価・待ち行列の差し替え・表示カードの変更を
//     すべて拒否する(できるのは同じ attempt の再送と、取得で確定済みかを見ることだけ)
//  B: その間に返った取得は反映せず保留し、attempt が確定してから反映する。
//     出している 1 枚は期限の到来や新しい due の出現では入れ替わらない
//  C: attempt の確定は 200(冪等を含む)と 409 だけ。通信失敗は unresolved に移る
//
// 拒否した action では同じ参照をそのまま返す(= 画面は 1 ミリも動かない)ので、`toBe` で押さえる。

import { describe, expect, it } from "vitest";
import { type Action, newSession, reduce, type Session } from "../src/client/review";
import type { ReviewAttempt } from "../src/client/review-api";
import type { DueCard, ReviewRating, ReviewState } from "../src/shared/review";

const NOW = Date.parse("2026-10-26T01:23:45.000Z");
const MINUTE = 60 * 1000;

function iso(at: number): string {
  return new Date(at).toISOString();
}

/** 期限が来ている新規カード 1 枚(due は既定で 1 分前)。 */
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

function attemptFor(cardId: string, rating: ReviewRating = 1, version = 1): ReviewAttempt {
  return {
    reviewId: `review-${cardId}-${rating}-${version}`,
    cardId,
    rating,
    expectedVersion: version,
    occurredAt: iso(NOW),
    elapsedMs: 1000,
  };
}

/** 評価を適用したあとのサーバの状態(既定は Again = 学習ステップ 1 分後)。 */
function appliedState(over: Partial<ReviewState> = {}): ReviewState {
  return {
    due: iso(NOW + MINUTE),
    version: 2,
    fsrs_state: 1,
    reps: 1,
    lapses: 0,
    scheduled_days: 0,
    last_review: iso(NOW),
    ...over,
  };
}

/** 取得を 1 回終えた状態(期限が早い 1 枚を出している)。 */
function loaded(cards: DueCard[] = [dueCard("A"), dueCard("B")]): Session {
  const started = reduce(newSession(), { type: "load_started", force: false, notice: null });
  return reduce(started, {
    type: "load_succeeded",
    generation: started.generation,
    cards,
    newRemaining: 20,
    now: NOW,
  });
}

const ATTEMPT = attemptFor("A");

/** A をめくって Again を送り始めた状態。 */
function sending(cards?: DueCard[]): Session {
  const revealed = reduce(loaded(cards), { type: "reveal", cardId: "A", now: NOW });
  const next = reduce(revealed, { type: "send_started", attempt: ATTEMPT });
  expect(next.phase).toEqual({ kind: "sending", attempt: ATTEMPT });
  return next;
}

/** 送ったが結果が分からない状態。 */
function unresolved(cards?: DueCard[]): Session {
  const next = reduce(sending(cards), {
    type: "send_unresolved",
    attempt: ATTEMPT,
    reason: "通信できなかった",
  });
  expect(next.phase).toMatchObject({ kind: "unresolved", attempt: ATTEMPT });
  return next;
}

/** どの action も状態を動かさないこと。 */
function rejectsAll(session: Session, actions: readonly Action[]): void {
  for (const action of actions) {
    expect(reduce(session, action), action.type).toBe(session);
  }
}

describe("復習の状態機械(取得と表示)", () => {
  it("取得し終えたら、期限がいちばん早い 1 枚を出す", () => {
    const session = loaded();
    expect(session.phase).toEqual({ kind: "showing", cardId: "A", revealedAt: null });
    expect(session.queue.map((q) => q.cardId)).toEqual(["A", "B"]);
    expect(session.fetching).toBe(false);
    expect(session.newRemaining).toBe(20);
  });

  it("出すカードが無ければ done、待ちがあれば idle", () => {
    expect(loaded([]).phase).toEqual({ kind: "done" });
    expect(loaded([dueCard("A", { due: iso(NOW + MINUTE) })]).phase).toEqual({ kind: "idle" });
  });

  it("裏をめくれるのは出している 1 枚だけ", () => {
    const session = loaded();
    expect(reduce(session, { type: "reveal", cardId: "B", now: NOW })).toBe(session);
    const revealed = reduce(session, { type: "reveal", cardId: "A", now: NOW });
    expect(revealed.phase).toEqual({ kind: "showing", cardId: "A", revealedAt: NOW });
    // めくり直しても時刻は動かない(評価までの時間を測り直さない)。
    expect(reduce(revealed, { type: "reveal", cardId: "A", now: NOW + 1000 })).toBe(revealed);
  });

  it("不変条件 B: 出している 1 枚は、別のカードの期限が来ても入れ替わらない", () => {
    const session = loaded([dueCard("A"), dueCard("B", { due: iso(NOW + MINUTE) })]);
    expect(session.phase).toEqual({ kind: "showing", cardId: "A", revealedAt: null });
    expect(reduce(session, { type: "tick", now: NOW + 2 * MINUTE })).toBe(session);
    // 新しい due が増えても出している 1 枚は変わらない(待ち行列だけ増える)。
    const reloaded = startAndApply(session, [dueCard("C"), dueCard("A"), dueCard("B")]);
    expect(reloaded.phase).toEqual(session.phase);
    expect(reloaded.queue.map((q) => q.cardId)).toEqual(["C", "A", "B"]);
  });

  it("待ちのあいだは期限が来た 1 枚を出す(tick)", () => {
    const session = loaded([dueCard("A", { due: iso(NOW + MINUTE) })]);
    expect(reduce(session, { type: "tick", now: NOW })).toBe(session);
    const shown = reduce(session, { type: "tick", now: NOW + MINUTE });
    expect(shown.phase).toEqual({ kind: "showing", cardId: "A", revealedAt: null });
  });

  it("取得中に重ねて始めない(世代も使わない)。開き直したときだけ取り直す", () => {
    const first = reduce(newSession(), { type: "load_started", force: false, notice: null });
    expect(first.fetching).toBe(true);
    expect(reduce(first, { type: "load_started", force: false, notice: null })).toBe(first);
    const forced = reduce(first, { type: "load_started", force: true, notice: null });
    expect(forced.generation).toBe(first.generation + 1);

    // 古い世代の応答(成功・失敗・認証切れ)は捨てる。
    const generation = first.generation;
    rejectsAll(forced, [
      { type: "load_succeeded", generation, cards: [dueCard("A")], newRemaining: 20, now: NOW },
      { type: "load_failed", generation, failure: "通信できなかった" },
      { type: "auth_expired", generation },
    ]);
  });

  it("取得に失敗したら「無い」とは言わず、理由を出す", () => {
    const started = reduce(newSession(), { type: "load_started", force: false, notice: null });
    const failed = reduce(started, {
      type: "load_failed",
      generation: started.generation,
      failure: "通信できなかった",
    });
    expect(failed.phase).toEqual({ kind: "idle" });
    expect(failed.failure).toBe("通信できなかった");
    expect(failed.fetching).toBe(false);
  });
});

describe("復習の状態機械(送信中・未確定)", () => {
  it("めくって出している 1 枚だけ、手元の version のまま送れる", () => {
    const revealed = reduce(loaded(), { type: "reveal", cardId: "A", now: NOW });
    rejectsAll(loaded(), [{ type: "send_started", attempt: ATTEMPT }]); // めくる前は送れない
    rejectsAll(revealed, [
      { type: "send_started", attempt: attemptFor("B") }, // 出していないカード
      { type: "send_started", attempt: attemptFor("A", 1, 5) }, // 手元に無い version
    ]);
    expect(reduce(revealed, { type: "send_started", attempt: ATTEMPT }).phase).toEqual({
      kind: "sending",
      attempt: ATTEMPT,
    });
  });

  it("不変条件 A: 送信中は他の評価・めくり直し・表示カードの変更をすべて拒否する", () => {
    const session = sending([dueCard("A"), dueCard("B", { due: iso(NOW + MINUTE) })]);
    rejectsAll(session, [
      { type: "send_started", attempt: attemptFor("B") },
      { type: "send_started", attempt: attemptFor("A", 3) },
      { type: "reveal", cardId: "B", now: NOW },
      { type: "tick", now: NOW + 2 * MINUTE },
      { type: "send_resolved", attempt: attemptFor("B"), state: appliedState(), now: NOW },
      { type: "send_unresolved", attempt: attemptFor("B"), reason: "通信できなかった" },
      { type: "send_conflicted", attempt: attemptFor("B") },
      { type: "load_started", force: true, notice: null }, // 結果は POST の応答で決まる
    ]);
  });

  it("不変条件 A: 未確定のあいだは、同じ attempt の再送だけができる", () => {
    const session = unresolved([dueCard("A"), dueCard("B", { due: iso(NOW + MINUTE) })]);
    rejectsAll(session, [
      { type: "send_started", attempt: attemptFor("B") }, // 他のカード
      { type: "send_started", attempt: attemptFor("A", 3) }, // 評価を変える
      { type: "reveal", cardId: "B", now: NOW },
      { type: "tick", now: NOW + 2 * MINUTE },
      // 送り直して 200 / 409 を受けるまでは確定しない(不変条件 C)。
      { type: "send_resolved", attempt: ATTEMPT, state: appliedState(), now: NOW },
      { type: "send_conflicted", attempt: ATTEMPT },
    ]);
    // 確定済みかを見る取得だけは始められる(出している 1 枚と再送キーは残る)。
    const checking = reduce(session, { type: "load_started", force: true, notice: null });
    expect(checking.phase).toBe(session.phase);
    expect(checking.fetching).toBe(true);
    // 同じ attempt の再送。
    expect(reduce(session, { type: "send_started", attempt: ATTEMPT }).phase).toEqual({
      kind: "sending",
      attempt: ATTEMPT,
    });
  });

  it("不変条件 B: 送信中に返った取得は保留し、確定してから反映する", () => {
    const session = sending();
    const held = reduce(session, {
      type: "load_succeeded",
      generation: session.generation,
      // サーバはまだ評価前の A を出している(この版で上書きしてはいけない)。
      cards: [dueCard("B"), dueCard("A")],
      newRemaining: 18,
      now: NOW,
    });
    expect(held.pending).toEqual({ cards: [dueCard("B"), dueCard("A")], newRemaining: 18 });
    expect(held.phase).toBe(session.phase);
    expect(held.queue).toBe(session.queue);
    expect(held.newRemaining).toBe(20);
    expect(held.fetching).toBe(false);

    const resolved = reduce(held, {
      type: "send_resolved",
      attempt: ATTEMPT,
      state: appliedState(),
      now: NOW,
    });
    expect(resolved.pending).toBeNull();
    expect(resolved.newRemaining).toBe(18);
    // A は確定した version / due の短期カードとして残り、保留していた B はここで入る。
    expect(resolved.queue.map((q) => [q.cardId, q.version, q.due])).toEqual([
      ["B", 1, dueCard("B").due],
      ["A", 2, appliedState().due],
    ]);
    expect(resolved.phase).toEqual({ kind: "showing", cardId: "B", revealedAt: null });
  });

  it("不変条件 C: 200 なら確定して次へ(短期カードは待ち時間つきで残る)", () => {
    const resolved = reduce(sending([dueCard("A")]), {
      type: "send_resolved",
      attempt: ATTEMPT,
      state: appliedState(),
      now: NOW,
    });
    expect(resolved.queue.map((q) => [q.cardId, q.version, q.due])).toEqual([
      ["A", 2, appliedState().due],
    ]);
    expect(resolved.phase).toEqual({ kind: "idle" });

    // 学習ステップを抜けた(待ちが長い)カードは手元に残さない。
    const graduated = reduce(sending([dueCard("A")]), {
      type: "send_resolved",
      attempt: ATTEMPT,
      state: appliedState({ fsrs_state: 2, due: iso(NOW + 3 * 24 * 60 * MINUTE) }),
      now: NOW,
    });
    expect(graduated.queue).toEqual([]);
    expect(graduated.phase).toEqual({ kind: "done" });
  });

  it("不変条件 C: 409 なら手元の古い 1 枚を落として取り直しに入る", () => {
    const session = sending();
    const held = reduce(session, {
      type: "load_succeeded",
      generation: session.generation,
      cards: [dueCard("A"), dueCard("B")],
      newRemaining: 18,
      now: NOW,
    });
    const conflicted = reduce(held, { type: "send_conflicted", attempt: ATTEMPT });
    expect(conflicted.queue.map((q) => q.cardId)).toEqual(["B"]);
    expect(conflicted.pending).toBeNull(); // 確定より前の内容なので使わない
    expect(conflicted.phase).toEqual({ kind: "idle" });
  });

  it("不変条件 C: 通信失敗は unresolved に移り、再送してから確定する", () => {
    const stuck = unresolved();
    expect(stuck.phase).toEqual({
      kind: "unresolved",
      attempt: ATTEMPT,
      reason: "通信できなかった",
    });
    // 待ち行列はそのまま(再送先も待ち時間も失わない)。
    expect(stuck.queue.map((q) => q.cardId)).toEqual(["A", "B"]);

    const resent = reduce(stuck, { type: "send_started", attempt: ATTEMPT });
    const resolved = reduce(resent, {
      type: "send_resolved",
      attempt: ATTEMPT,
      state: appliedState(),
      now: NOW,
    });
    expect(resolved.queue.map((q) => [q.cardId, q.version])).toEqual([
      ["B", 1],
      ["A", 2],
    ]);
    expect(resolved.phase).toEqual({ kind: "showing", cardId: "B", revealedAt: null });
  });

  it("認証切れのあとは、どの action も受け付けない(再送ループを作らない)", () => {
    const expired = reduce(unresolved(), { type: "auth_expired", generation: null });
    expect(expired.authExpired).toBe(true);
    expect(expired.fetching).toBe(false);
    rejectsAll(expired, [
      { type: "load_started", force: true, notice: null },
      { type: "send_started", attempt: ATTEMPT },
      { type: "reveal", cardId: "A", now: NOW },
      { type: "tick", now: NOW + MINUTE },
    ]);
  });
});

/** 取得を 1 回ぶん流す(開始 → 成功)。 */
function startAndApply(session: Session, cards: DueCard[]): Session {
  const started = reduce(session, { type: "load_started", force: false, notice: null });
  return reduce(started, {
    type: "load_succeeded",
    generation: started.generation,
    cards,
    newRemaining: 20,
    now: NOW,
  });
}
