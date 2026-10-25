-- lingo の初期 schema(設計書 §3)。
-- 時刻はすべて UTC の ISO 8601 文字列("YYYY-MM-DDTHH:MM:SS.sssZ")で保存する。
-- 文字列 <-> Date の変換は src/worker/time.ts だけが行う。
-- このファイルは追加のみの原則に従い、以後書き換えない(破壊的な変更は書かない)。
-- 同じ内容を 2 回流しても落ちないように IF NOT EXISTS / ON CONFLICT DO NOTHING を使う。

-- デッキ。当面は固定の 1 件だけを使う。
CREATE TABLE IF NOT EXISTS decks (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 単語カード。削除は deleted_at による論理削除。
CREATE TABLE IF NOT EXISTS cards (
  id         TEXT PRIMARY KEY,                     -- UUID
  deck_id    TEXT NOT NULL REFERENCES decks (id),
  term       TEXT NOT NULL,                        -- 単語
  meaning    TEXT NOT NULL,                        -- 意味
  example    TEXT,                                 -- 例文(任意)
  note       TEXT,                                 -- メモ(任意)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT                                  -- NULL = 生存
);

CREATE INDEX IF NOT EXISTS idx_cards_deck ON cards (deck_id, deleted_at);

-- FSRS のスケジュール状態。カード 1 枚に 1 行。列は ts-fsrs の Card に対応する。
CREATE TABLE IF NOT EXISTS card_state (
  card_id        TEXT PRIMARY KEY REFERENCES cards (id),
  due            TEXT NOT NULL,
  stability      REAL NOT NULL,
  difficulty     REAL NOT NULL,
  elapsed_days   INTEGER NOT NULL,
  scheduled_days INTEGER NOT NULL,
  learning_steps INTEGER NOT NULL,                 -- 学習ステップの何段目か(ts-fsrs Card.learning_steps)
  reps           INTEGER NOT NULL,
  lapses         INTEGER NOT NULL,
  state          INTEGER NOT NULL,                 -- ts-fsrs State(0=New 1=Learning 2=Review 3=Relearning)
  last_review    TEXT,                             -- 未解答なら NULL
  version        INTEGER NOT NULL,                 -- 楽観ロック(更新のたびに +1)
  updated_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_card_state_due ON card_state (due);

-- 解答ログ。review_id が冪等キー。訂正は行を書き換えず correction_of で追記する。
CREATE TABLE IF NOT EXISTS reviews (
  review_id      TEXT PRIMARY KEY,                 -- 端末が採番する UUID(再送しても 1 回だけ効く)
  card_id        TEXT NOT NULL REFERENCES cards (id),
  rating         INTEGER NOT NULL,                 -- ts-fsrs Rating(0=Manual 1=Again 2=Hard 3=Good 4=Easy)
  occurred_at    TEXT NOT NULL,                    -- 端末で解答した時刻(UTC)
  received_at    TEXT NOT NULL,                    -- サーバが受け取った時刻(UTC)
  state_before   TEXT NOT NULL,                    -- JSON: 適用前の card_state
  state_after    TEXT NOT NULL,                    -- JSON: 適用後の card_state
  review_log     TEXT NOT NULL,                    -- JSON: ts-fsrs の ReviewLog
  fsrs_version   TEXT NOT NULL,                    -- 計算に使った ts-fsrs の版
  params_version INTEGER NOT NULL,                 -- 計算に使った settings.params_version
  correction_of  TEXT REFERENCES reviews (review_id)
);

CREATE INDEX IF NOT EXISTS idx_reviews_card ON reviews (card_id, occurred_at);

-- 設定。1 行だけ持つ。
CREATE TABLE IF NOT EXISTS settings (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  timezone          TEXT NOT NULL,                 -- 「今日」の境界計算に使う
  new_cards_per_day INTEGER NOT NULL,              -- 1 日の新規上限
  learning_steps    TEXT NOT NULL,                 -- JSON: ts-fsrs の learning_steps
  relearning_steps  TEXT NOT NULL,                 -- JSON: ts-fsrs の relearning_steps
  request_retention REAL NOT NULL,
  maximum_interval  INTEGER NOT NULL,
  enable_fuzz       INTEGER NOT NULL,              -- 0/1
  enable_short_term INTEGER NOT NULL,              -- 0/1
  fsrs_w            TEXT NOT NULL,                 -- JSON: FSRS-6 の重み(ts-fsrs の既定)
  params_version    INTEGER NOT NULL,              -- パラメータを変えたら +1(reviews に記録する)
  updated_at        TEXT NOT NULL
);

-- 固定デッキ 1 件。
INSERT INTO decks (id, name, created_at, updated_at)
VALUES (
  '00000000-0000-4000-8000-000000000001',
  'TOEIC',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
ON CONFLICT (id) DO NOTHING;

-- 設定の初期値(FSRS パラメータは ts-fsrs 5.4.2 の既定 = FSRS-6)。
INSERT INTO settings (
  id,
  timezone,
  new_cards_per_day,
  learning_steps,
  relearning_steps,
  request_retention,
  maximum_interval,
  enable_fuzz,
  enable_short_term,
  fsrs_w,
  params_version,
  updated_at
)
VALUES (
  1,
  'Asia/Tokyo',
  10,
  '["1m","10m"]',
  '["10m"]',
  0.9,
  36500,
  0,
  1,
  '[0.212,1.2931,2.3065,8.2956,6.4133,0.8334,3.0194,0.001,1.8722,0.1666,0.796,1.4835,0.0614,0.2629,1.6483,0.6014,1.8729,0.5425,0.0912,0.0658,0.1542]',
  1,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
ON CONFLICT (id) DO NOTHING;
