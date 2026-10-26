import { createEmptyCard, FSRSVersion, generatorParameters, Rating, State } from "ts-fsrs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DUE_LIMIT,
  MAX_DUE_LIMIT,
  MAX_ELAPSED_MS,
  MAX_REVIEW_ID_LENGTH,
  parseDueLimit,
  parseReviewRequest,
  queueOfFsrsState,
} from "../src/shared/review";
import { applyReview, toCardStateRow, toReviewState } from "../src/worker/fsrs";
import { dayWindow, toUtcIso } from "../src/worker/time";

// FSRS の計算と「今日」の境界、本文の検証の単体テスト。
// このファイルは HTTP も D1 も使わない(純関数だけを呼ぶ)。

const CARD_ID = "11111111-2222-4333-8444-555555555555";
const NOW = new Date("2026-10-26T01:23:45.000Z");
const MINUTE = 60 * 1000;

/** 新規カード(取り込み直後)の card_state 行。 */
function newState(at: Date = NOW) {
  return toCardStateRow(CARD_ID, createEmptyCard(at), 1, at);
}

/** 既定の設定(migration が入れる値と同じ: 学習ステップ 1m・10m、fuzz なし)。 */
const PARAMETERS = generatorParameters({
  learning_steps: ["1m", "10m"],
  relearning_steps: ["10m"],
});

function review(rating: 1 | 2 | 3 | 4, state = newState(), at = NOW, receivedAt = at) {
  return applyReview({ state, rating, occurredAt: at, receivedAt, parameters: PARAMETERS });
}

describe("applyReview(FSRS の純関数)", () => {
  it("適用前の行をそのまま残し、version を 1 つ進める", () => {
    const state = newState();
    const applied = review(3, state);

    expect(applied.state_before).toEqual(state);
    expect(applied.state_after.version).toBe(state.version + 1);
    expect(applied.state_after.card_id).toBe(CARD_ID);
    expect(applied.fsrs_version).toBe(FSRSVersion);
    expect(applied.review_log.rating).toBe(Rating.Good);
    // 入力の行は書き換えない(純関数)。
    expect(state.version).toBe(1);
    expect(state.fsrs_state).toBe(State.New);
  });

  it("行の時刻は UTC 保存で、updated_at は受け取った時刻", () => {
    const receivedAt = new Date(NOW.getTime() + 1500);
    const applied = review(3, newState(), NOW, receivedAt);

    expect(applied.state_after.updated_at).toBe(toUtcIso(receivedAt));
    expect(applied.state_after.last_review).toBe(toUtcIso(NOW));
    expect(applied.state_after.due).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("Again は学習ステップの 1 段目(1 分後)に戻す", () => {
    const applied = review(1);

    expect(applied.state_after.fsrs_state).toBe(State.Learning);
    expect(Date.parse(applied.state_after.due) - NOW.getTime()).toBe(1 * MINUTE);
    expect(applied.state_after.scheduled_days).toBe(0);
    expect(applied.state_after.reps).toBe(1);
  });

  it("新規の Good は学習ステップの 2 段目(10 分後)に送る", () => {
    const applied = review(3);

    expect(applied.state_after.fsrs_state).toBe(State.Learning);
    expect(Date.parse(applied.state_after.due) - NOW.getTime()).toBe(10 * MINUTE);
    expect(applied.state_after.learning_steps).toBe(1);
  });

  it("学習ステップを抜けると日単位の復習になる", () => {
    const first = review(3);
    const at = new Date(Date.parse(first.state_after.due));
    const second = review(3, first.state_after, at);

    expect(second.state_after.fsrs_state).toBe(State.Review);
    expect(second.state_after.scheduled_days).toBeGreaterThanOrEqual(1);
    expect(Date.parse(second.state_after.due)).toBeGreaterThan(at.getTime() + 24 * 60 * MINUTE - 1);
    expect(second.state_after.version).toBe(3);
  });

  it("Again は復習中のカードを再学習に落とし、再学習ステップで出し直す", () => {
    const learning = review(3);
    const graduated = review(
      3,
      learning.state_after,
      new Date(Date.parse(learning.state_after.due)),
    );
    const at = new Date(Date.parse(graduated.state_after.due));
    const lapsed = review(1, graduated.state_after, at);

    expect(lapsed.state_after.fsrs_state).toBe(State.Relearning);
    expect(Date.parse(lapsed.state_after.due) - at.getTime()).toBe(10 * MINUTE);
    expect(lapsed.state_after.lapses).toBe(1);
  });

  it("学習ステップは設定の値どおりに効く(短期再出題の間隔)", () => {
    const applied = applyReview({
      state: newState(),
      rating: 1,
      occurredAt: NOW,
      receivedAt: NOW,
      parameters: generatorParameters({ learning_steps: ["5m", "30m"] }),
    });
    expect(Date.parse(applied.state_after.due) - NOW.getTime()).toBe(5 * MINUTE);
  });

  it("rating は 1=Again 2=Hard 3=Good 4=Easy の順に間隔が伸びる", () => {
    const dues = ([1, 2, 3, 4] as const).map((rating) =>
      Date.parse(review(rating).state_after.due),
    );
    expect(dues).toEqual([...dues].sort((a, b) => a - b));
    expect(new Set(dues).size).toBe(4);
  });

  it("基準時刻は端末が解答した時刻(occurred_at)", () => {
    const occurredAt = new Date(NOW.getTime() - 30 * MINUTE);
    const applied = review(1, newState(), occurredAt, NOW);
    expect(Date.parse(applied.state_after.due) - occurredAt.getTime()).toBe(1 * MINUTE);
  });
});

describe("toReviewState", () => {
  it("応答に出すのは次の version と due などだけ", () => {
    const applied = review(3);
    expect(toReviewState(applied.state_after)).toEqual({
      due: applied.state_after.due,
      version: 2,
      fsrs_state: State.Learning,
      reps: 1,
      lapses: 0,
      scheduled_days: 0,
      last_review: toUtcIso(NOW),
    });
  });
});

describe("dayWindow(「今日」の境界だけ JST)", () => {
  it("JST の 0 時は UTC 15:00", () => {
    const { start, end } = dayWindow(new Date("2026-10-26T01:23:45.000Z"), "Asia/Tokyo");
    expect(toUtcIso(start)).toBe("2026-10-25T15:00:00.000Z");
    expect(toUtcIso(end)).toBe("2026-10-26T15:00:00.000Z");
  });

  it("UTC 15:00 の前後で窓が入れ替わる", () => {
    const before = dayWindow(new Date("2026-10-26T14:59:59.999Z"), "Asia/Tokyo");
    const after = dayWindow(new Date("2026-10-26T15:00:00.000Z"), "Asia/Tokyo");
    expect(toUtcIso(before.start)).toBe("2026-10-25T15:00:00.000Z");
    expect(toUtcIso(before.end)).toBe("2026-10-26T15:00:00.000Z");
    expect(toUtcIso(after.start)).toBe("2026-10-26T15:00:00.000Z");
    expect(toUtcIso(after.end)).toBe("2026-10-27T15:00:00.000Z");
  });

  it("窓は start 以上 end 未満で、隣の日と隙間なく続く", () => {
    const day = dayWindow(new Date("2026-12-31T20:00:00.000Z"), "Asia/Tokyo"); // JST 2027-01-01
    expect(toUtcIso(day.start)).toBe("2026-12-31T15:00:00.000Z");
    expect(toUtcIso(day.end)).toBe("2027-01-01T15:00:00.000Z");
    expect(dayWindow(day.end, "Asia/Tokyo").start.getTime()).toBe(day.end.getTime());
    expect(dayWindow(new Date(day.start.getTime() - 1), "Asia/Tokyo").end.getTime()).toBe(
      day.start.getTime(),
    );
  });

  it("UTC では日付がそのまま 0 時になる", () => {
    const { start, end } = dayWindow(new Date("2026-10-26T01:23:45.000Z"), "UTC");
    expect(toUtcIso(start)).toBe("2026-10-26T00:00:00.000Z");
    expect(toUtcIso(end)).toBe("2026-10-27T00:00:00.000Z");
  });
});

describe("queueOfFsrsState", () => {
  it("New は新規、Review は復習、Learning / Relearning は学習中", () => {
    expect(queueOfFsrsState(State.New)).toBe("new");
    expect(queueOfFsrsState(State.Review)).toBe("review");
    expect(queueOfFsrsState(State.Learning)).toBe("learning");
    expect(queueOfFsrsState(State.Relearning)).toBe("learning");
  });
});

describe("parseReviewRequest", () => {
  const valid = {
    review_id: "99999999-8888-4777-8666-555555555555",
    card_id: CARD_ID,
    rating: 3,
    expected_version: 1,
    occurred_at: "2026-10-26T01:23:45.000Z",
    elapsed_ms: 4200,
  };

  it("正しい本文は Date に直して通す", () => {
    const { request, error } = parseReviewRequest(valid);
    expect(error).toBeUndefined();
    expect(request).toEqual({
      review_id: valid.review_id,
      card_id: CARD_ID,
      rating: 3,
      expected_version: 1,
      occurred_at: new Date(valid.occurred_at),
      elapsed_ms: 4200,
    });
  });

  it("occurred_at のオフセット表記は UTC の瞬間として読む", () => {
    const { request } = parseReviewRequest({ ...valid, occurred_at: "2026-10-26T10:23:45+09:00" });
    expect(request && toUtcIso(request.occurred_at)).toBe("2026-10-26T01:23:45.000Z");
  });

  it("elapsed_ms は省略・null を許す", () => {
    const { elapsed_ms: _omitted, ...without } = valid;
    expect(parseReviewRequest(without).request?.elapsed_ms).toBeNull();
    expect(parseReviewRequest({ ...valid, elapsed_ms: null }).request?.elapsed_ms).toBeNull();
  });

  it("expected_version は 0 を許す(状態が無い場合の表現)", () => {
    expect(parseReviewRequest({ ...valid, expected_version: 0 }).request?.expected_version).toBe(0);
  });

  it("どのフィールドがなぜ駄目かを返す", () => {
    const cases: [unknown, string][] = [
      ["文字列", "invalid_json"],
      [[], "invalid_json"],
      [null, "invalid_json"],
      [{ ...valid, review_id: undefined }, "invalid_review_id"],
      [{ ...valid, review_id: "  " }, "invalid_review_id"],
      [{ ...valid, review_id: "x".repeat(MAX_REVIEW_ID_LENGTH + 1) }, "invalid_review_id"],
      [{ ...valid, card_id: 1 }, "invalid_card_id"],
      [{ ...valid, rating: 0 }, "invalid_rating"], // Manual は送れない
      [{ ...valid, rating: 5 }, "invalid_rating"],
      [{ ...valid, rating: "3" }, "invalid_rating"],
      [{ ...valid, expected_version: -1 }, "invalid_expected_version"],
      [{ ...valid, expected_version: 1.5 }, "invalid_expected_version"],
      [{ ...valid, expected_version: "1" }, "invalid_expected_version"],
      [{ ...valid, occurred_at: "きのう" }, "invalid_occurred_at"],
      [{ ...valid, occurred_at: 1_700_000_000 }, "invalid_occurred_at"],
      [{ ...valid, elapsed_ms: -1 }, "invalid_elapsed_ms"],
      [{ ...valid, elapsed_ms: MAX_ELAPSED_MS + 1 }, "invalid_elapsed_ms"],
      [{ ...valid, elapsed_ms: "4200" }, "invalid_elapsed_ms"],
    ];
    for (const [body, code] of cases) {
      const { request, error } = parseReviewRequest(body);
      expect(request, JSON.stringify(body)).toBeUndefined();
      expect(error?.code, JSON.stringify(body)).toBe(code);
      expect(error?.message, JSON.stringify(body)).not.toBe("");
    }
  });
});

describe("parseDueLimit", () => {
  it("省略なら既定、範囲内の整数はそのまま", () => {
    expect(parseDueLimit(undefined)).toBe(DEFAULT_DUE_LIMIT);
    expect(parseDueLimit(null)).toBe(DEFAULT_DUE_LIMIT);
    expect(parseDueLimit("")).toBe(DEFAULT_DUE_LIMIT);
    expect(parseDueLimit("1")).toBe(1);
    expect(parseDueLimit("20")).toBe(20);
    expect(parseDueLimit(String(MAX_DUE_LIMIT))).toBe(MAX_DUE_LIMIT);
  });

  it("整数でない・範囲外は null(呼び出し側が 400 にする)", () => {
    for (const value of ["0", "-1", "1.5", "abc", "20x", " 20", String(MAX_DUE_LIMIT + 1)]) {
      expect(parseDueLimit(value), value).toBeNull();
    }
  });
});
