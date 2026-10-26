-- reviews に version_before(評価を適用する前の card_state.version)を足す(設計書 §4 / Issue 3)。
-- POST /api/review の batch を「reviews の INSERT」と「card_state の条件付き UPDATE」だけで原子的に
-- するために使う。UPDATE 側が「この review_id・この card_id・この version_before のログがある」ことを
-- 条件にできるので、INSERT が冪等キーの衝突で無視されたときは UPDATE も必ず 0 件になる
-- (= 同じ冪等キーで state が 2 回進むことがない)。値は state_before.version と同じものを入れる。
--
-- 0001 は凍結済みなのでここで足す。追加のみの原則に従い、このファイルも以後書き換えない
-- (DROP も列削除も書かない)。SQLite の ALTER TABLE ADD COLUMN には IF NOT EXISTS が無いが、
-- 適用済みの migration は wrangler が飛ばすので 2 回流れることはない。
--
-- 新旧コード互換: 列は NULL 可。既存行と、この列を知らない旧コードが入れた行は NULL になる
-- (migration 成功 → deploy 失敗でも旧コードはそのまま動く)。

ALTER TABLE reviews ADD COLUMN version_before INTEGER;
