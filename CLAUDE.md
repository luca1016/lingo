# CLAUDE.md

lingo — 自分ひとり用の語彙 SRS(TOEIC 単語カードを FSRS で回す)。Cloudflare Workers(Hono)+ Static Assets(Preact + Vite)+ D1。
設計書は brain の `projects/lingo.md`(Issue の背景・契約はそこが正)。

## 構成

- `src/worker/` Worker(Hono)。`app.ts` が経路、`access.ts` が Cloudflare Access JWT 検証、`guard.ts` が POST の共通ガード
- `src/client/` フロント(Preact、UI ライブラリなし、スマホ 1 カラム)。`index.html` がエントリ、`dist/` に出る
- `migrations/` D1 の migration(`NNNN_<name>.sql`)
- `test/` Vitest(`@cloudflare/vitest-plugin` で workerd 上、`wrangler.jsonc` を読み、ローカル D1 に migration 適用済み)
- `worker-configuration.d.ts` は生成物(`pnpm cf-typegen`)。`wrangler.jsonc` を変えたら再生成して commit

## 規約

- パッケージ管理は pnpm。`pnpm typecheck` / `pnpm check`(Biome)/ `pnpm test`(Vitest)/ `pnpm build`(Vite + `wrangler deploy --dry-run`)がすべて通ること。
- **依存は増やさない**(Issue に明記がある場合のみ)。
- **migration は追加のみ**。既存の migration を書き換えない。`DROP`・列削除は書かない(release 手順で人が判断する)。新旧コード互換を保つ。
- **Access を外さない**: `/api/health` 以外のすべての経路(静的アセット含む)で JWT 検証を通す。設定欠落時は拒否のまま。
  テストで差し替えてよいのは JWKS 取得関数(`createApp({ jwks })`)だけ。
- **`run_worker_first: true` を外さない**。`workers_dev` / `preview_urls` を有効にしない。
- **時刻は UTC で保存**。JST は「今日」の境界計算にだけ使う。テストは固定時計(`vi.setSystemTime`)。
- **冪等キー(`review_id`, `import_id`)と `card_state.version`(楽観ロック)を壊さない**。削除は論理削除、訂正はログで。
- POST は JSON + 同一 Origin(`guard.ts`)。
- Cloudflare の資格情報を使う操作(`wrangler deploy` / `--remote`)はしない。`wrangler` はローカル(`--local` / `--dry-run`)のみ。
- コミットメッセージは日本語で「何を・なぜ」。

## ランナーへの注意

- Issue の受け入れ条件がすべて満たされたら終わり。それ以上のことはしない。
- 曖昧なら質問して止まる(推測で進めない)。
- `main` には触らない。PR は人が merge する。merge は本番ではない(本番は人が release workflow で昇格する)。

## 応答

日本語。
