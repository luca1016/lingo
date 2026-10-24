# migrations

D1 の migration(`wrangler d1 migrations create lingo-db <name>` で `NNNN_<name>.sql` を作る)。

- **追加のみ**。既存ファイルは書き換えない。
- `DROP` や列削除は書かない。必要になったら release 手順の中で人が別途判断する。
- 新旧コード互換を原則にする(migration 成功 → deploy 失敗でも旧コードが動くこと)。
- 適用: CI はローカル D1、本番 / preview は release / preview workflow(人が起動)。
