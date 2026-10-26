-- カード取り込みの冪等キー(設計書 §4 / Issue 2)。
-- POST /api/cards は import_id で冪等にする。同じ import_id の再送には、1 回目に返した応答本文
-- (result の JSON)をそのまま返し、カードを増やさない。
-- 時刻は UTC の ISO 8601 文字列("YYYY-MM-DDTHH:MM:SS.sssZ")で保存する(src/worker/time.ts)。
-- 追加のみの原則に従い、このファイルは以後書き換えない。
-- 同じ内容を 2 回流しても落ちないように IF NOT EXISTS を使う(ALTER TABLE は書かない)。

CREATE TABLE IF NOT EXISTS imports (
  -- 端末が採番する UUID(再送しても 1 回だけ効く)。
  -- SQLite では TEXT PRIMARY KEY だけでは NULL を弾けないので NOT NULL も書く。
  import_id   TEXT PRIMARY KEY NOT NULL,
  received_at TEXT NOT NULL,                       -- サーバが受け取った時刻(UTC)
  added       INTEGER NOT NULL,                    -- 実際に追加したカード数
  result      TEXT NOT NULL                        -- JSON: 1 回目に返した応答本文(再送でそのまま返す)
);

CREATE INDEX IF NOT EXISTS idx_imports_received ON imports (received_at);
