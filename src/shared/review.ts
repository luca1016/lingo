// 復習エンジンの契約(設計書 §1・§3・§4 / Issue 3)。
// GET /api/due と POST /api/review の要求・応答の形と、本文の検証をここだけに書く
// (Worker と画面が同じ規則を使う)。このファイルは純粋な TypeScript で、D1 も DOM も触らない。

/** GET /api/due の既定の上限(`?limit` 省略時)。 */
export const DEFAULT_DUE_LIMIT = 20;

/** GET /api/due の `?limit` に指定できる最大。 */
export const MAX_DUE_LIMIT = 100;

/** review_id(端末が採番する UUID)の長さの上限。 */
export const MAX_REVIEW_ID_LENGTH = 64;

/** card_id の長さの上限(UUID を見込む)。 */
export const MAX_CARD_ID_LENGTH = 64;

/** 評価にかかった時間(ms)の上限。これより大きい値は壊れた計測として受け取らない。 */
export const MAX_ELAPSED_MS = 24 * 60 * 60 * 1000;

/** ts-fsrs Rating のうち端末から送れるもの(0=Manual は送れない)。 */
export const RATINGS = [1, 2, 3, 4] as const;

/** 1=Again 2=Hard 3=Good 4=Easy(ts-fsrs の Rating に 1 対 1 で対応する)。 */
export type ReviewRating = (typeof RATINGS)[number];

/** 出題の待ち行列。この順に並べる(学習中 → 復習 → 新規)。 */
export const DUE_QUEUES = ["learning", "review", "new"] as const;

export type DueQueue = (typeof DUE_QUEUES)[number];

/** ts-fsrs State(0=New 1=Learning 2=Review 3=Relearning)から待ち行列を決める。 */
export function queueOfFsrsState(fsrsState: number): DueQueue {
  if (fsrsState === 0) return "new";
  if (fsrsState === 2) return "review";
  return "learning"; // Learning / Relearning はどちらも「学習中」
}

/** GET /api/due の 1 枚。`version` をそのまま POST /api/review の `expected_version` に入れる。 */
export interface DueCard {
  card_id: string;
  front: string;
  back: string;
  example: string | null;
  note: string | null;
  /** 次に出す時刻(UTC)。 */
  due: string;
  /** card_state の現在の版(楽観ロック)。 */
  version: number;
  /** ts-fsrs State。 */
  fsrs_state: number;
  /** どの待ち行列から出たか。 */
  queue: DueQueue;
  reps: number;
  lapses: number;
}

/** GET /api/due の応答。 */
export interface DueResponse {
  /** サーバが見た現在時刻(UTC)。 */
  now: string;
  /** 適用した上限。 */
  limit: number;
  /** 学習中 → 復習 → 新規の順。 */
  cards: DueCard[];
  /**
   * 次に期限が来る時刻(学習中・復習のうち最も近い未来の `due`)。無ければ null。
   * `cards` が空のとき、画面が「つぎのカードまで」の待ち時間を出すために使う。
   */
  next_due_at: string | null;
  /** その日(settings の timezone)に初回評価を確定したユニーク枚数。 */
  new_today: number;
  /** その日あと何枚の新規を出せるか。 */
  new_remaining: number;
}

/** POST /api/review の本文(検証済み)。 */
export interface ReviewRequest {
  review_id: string;
  card_id: string;
  rating: ReviewRating;
  /** 読み出したときの card_state.version。合わなければ 409。 */
  expected_version: number;
  /** 端末が解答した時刻(FSRS の基準時刻)。 */
  occurred_at: Date;
  /** 解答にかかった時間(ms)。測れなければ null。 */
  elapsed_ms: number | null;
}

/** 応答に出す FSRS 状態(適用後。`version` が次の `expected_version`)。 */
export interface ReviewState {
  due: string;
  version: number;
  fsrs_state: number;
  reps: number;
  lapses: number;
  scheduled_days: number;
  last_review: string | null;
}

/** POST /api/review の応答。同じ review_id の再送には必ずこれと同じものを返す。 */
export interface ReviewResponse {
  review_id: string;
  card_id: string;
  rating: number;
  /** 保存した occurred_at(UTC に正規化済み)。 */
  occurred_at: string;
  state: ReviewState;
}

export type ReviewErrorCode =
  | "invalid_json"
  | "invalid_review_id"
  | "invalid_card_id"
  | "invalid_rating"
  | "invalid_expected_version"
  | "invalid_occurred_at"
  | "invalid_elapsed_ms"
  | "invalid_limit"
  | "card_not_found"
  | "version_conflict";

/** 失敗時の応答本文(4xx)。何も変更していない。 */
export interface ReviewErrorResponse {
  error: ReviewErrorCode;
  message: string;
  /** version_conflict のときだけ、サーバ側の今の状態(これを見て出し直せる)。 */
  state?: ReviewState;
}

/** 本文の不正を 1 つ表す(どのフィールドがなぜ駄目か)。 */
export interface ReviewRequestError {
  code: ReviewErrorCode;
  message: string;
}

function invalid(code: ReviewErrorCode, message: string): { error: ReviewRequestError } {
  return { error: { code, message } };
}

function validId(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= max;
}

/** 0 以上の整数か。 */
function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * POST /api/review の本文を検証する(純粋。D1 も時計も見ない)。
 * 通れば `request`、駄目なら理由が `error` に入る。
 */
export function parseReviewRequest(
  body: unknown,
):
  | { request: ReviewRequest; error?: undefined }
  | { request?: undefined; error: ReviewRequestError } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return invalid("invalid_json", "本文は JSON オブジェクトで送る");
  }
  const {
    review_id: reviewId,
    card_id: cardId,
    rating,
    expected_version: expectedVersion,
    occurred_at: occurredAt,
    elapsed_ms: elapsedMs,
  } = body as Record<string, unknown>;

  if (!validId(reviewId, MAX_REVIEW_ID_LENGTH)) {
    return invalid(
      "invalid_review_id",
      `review_id は 1〜${MAX_REVIEW_ID_LENGTH} 文字の文字列で送る`,
    );
  }
  if (!validId(cardId, MAX_CARD_ID_LENGTH)) {
    return invalid("invalid_card_id", `card_id は 1〜${MAX_CARD_ID_LENGTH} 文字の文字列で送る`);
  }
  if (!RATINGS.includes(rating as ReviewRating)) {
    return invalid("invalid_rating", "rating は 1=Again 2=Hard 3=Good 4=Easy のどれか");
  }
  if (!isNonNegativeInt(expectedVersion)) {
    return invalid("invalid_expected_version", "expected_version は 0 以上の整数で送る");
  }
  if (typeof occurredAt !== "string" || Number.isNaN(Date.parse(occurredAt))) {
    return invalid("invalid_occurred_at", "occurred_at は ISO 8601 の時刻で送る");
  }
  if (
    elapsedMs !== undefined &&
    elapsedMs !== null &&
    (!isNonNegativeInt(elapsedMs) || elapsedMs > MAX_ELAPSED_MS)
  ) {
    return invalid("invalid_elapsed_ms", `elapsed_ms は 0〜${MAX_ELAPSED_MS} の整数か null で送る`);
  }

  return {
    request: {
      review_id: reviewId,
      card_id: cardId,
      rating: rating as ReviewRating,
      expected_version: expectedVersion,
      occurred_at: new Date(Date.parse(occurredAt)),
      elapsed_ms: elapsedMs === undefined ? null : (elapsedMs as number | null),
    },
  };
}

/**
 * GET /api/due の `?limit` を読む(純粋)。
 * 省略なら既定、1〜上限の整数でなければ null(= 400)。
 */
export function parseDueLimit(value: string | undefined | null): number | null {
  if (value === undefined || value === null || value === "") return DEFAULT_DUE_LIMIT;
  if (!/^\d+$/.test(value)) return null;
  const limit = Number(value);
  if (limit < 1 || limit > MAX_DUE_LIMIT) return null;
  return limit;
}
