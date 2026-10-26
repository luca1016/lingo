# lingo

自分ひとり用の語彙 SRS(TOEIC 単語カードを FSRS で回す、スマホ優先の Web アプリ)。設計書: brain `projects/lingo.md`。

## 構成

```
GitHub luca1016/lingo
  PR / main ─▶ Actions "test"(ci.yml): typecheck → Biome → Vitest(workerd + ローカル D1)→ Vite build + wrangler deploy --dry-run
               ※ Cloudflare 資格情報なし。merge は本番ではない
  人が "release"(release.yml)を起動 ─▶ Environment "production" 承認
               ─▶ build → D1 export(artifact)→ d1 migrations apply(本番)→ wrangler deploy → /api/health 疎通 → 失敗時 rollback
  人が "preview"(preview.yml)を起動 ─▶ Environment "preview" 承認
               ─▶ d1 migrations apply(lingo-db-preview)→ wrangler deploy --env preview → URL を PR にコメント

ブラウザ ─▶ Cloudflare Access(自分のメールのみ)─▶ Worker "lingo"(カスタムドメインのみ。workers.dev / Preview URL 無効)
              Worker: run_worker_first: true
                /api/health        認証外(版情報のみ)
                それ以外すべて      Access JWT 検証(署名・issuer・aud・期限・email)→ API(Hono)/ 静的アセット(Vite の dist/)
                拒否の返し方        /api/* は 401(画面が再ログインを案内する)、それ以外は 403。
                                   設定(vars)欠落は再ログインでは直らないので常に 403
                D1: 本番 lingo-db / 非本番 lingo-db-preview
```

## 開発

```sh
pnpm install
pnpm typecheck && pnpm check && pnpm test && pnpm build
pnpm cf-typegen   # wrangler.jsonc を変えたら worker-configuration.d.ts を再生成
```

`wrangler.jsonc` の `vars`(`ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` / `ALLOWED_EMAIL`)は空で commit する。空のままだと Worker は全経路 403
(設定欠落時は拒否)。値は release / preview workflow が GitHub Secrets から `wrangler deploy --var` で注入する。

## 人がやる基盤作業(設計書 §6 Issue 0)

ランナーはここをやらない(Cloudflare の資格情報は GitHub Secrets 以外に置かない)。上から順に。

**画面操作つきの詳しい手順書: [docs/SETUP.md](docs/SETUP.md)**(初めての人はこちらを上から順に)。

### Cloudflare 側

**(a) Access アプリ**(Zero Trust → Access → Applications)
1. Login method に One-time PIN(メール OTP)を有効化する。
2. Add an application → **Self-hosted**。Application domain = 本番のカスタムドメイン(例 `lingo.example.com`、パスは空 = 全体)。
3. Policy: Action **Allow**、Include = **Emails** に自分のメールだけ。
4. 作成後、Overview の **Application Audience (AUD) Tag** をメモ → Secret `ACCESS_AUD`。チーム名(`<team>.cloudflareaccess.com` の `<team>`)→ Secret `ACCESS_TEAM_DOMAIN`。
5. **health 用の Bypass**: もう 1 つ Self-hosted アプリを作り、domain = 同じドメイン + path `api/health`、Policy は Action **Bypass** / Include Everyone。
   (release の疎通確認が外から `/api/health` を叩くため。Worker 側も health は版情報しか返さない)
6. preview 用ドメイン(例 `lingo-preview.example.com`)にも同じ 2 つ(本体 Allow + health Bypass)を作る。AUD は別になるので preview の Secret に入れる。

**(b) D1**(PC で一時的に `wrangler login` するか、ダッシュボードで作成)
```sh
pnpm exec wrangler d1 create lingo-db
pnpm exec wrangler d1 create lingo-db-preview
```
出てきた `database_id` を `wrangler.jsonc` の `REPLACE_ME_PROD`(トップレベル)と `REPLACE_ME_PREVIEW`(`env.preview`)に入れて PR で commit する
(ID は秘密ではない)。

**(c) 入口の棚卸し**
1. 初回 release(または手で 1 回 deploy)で Worker `lingo` / `lingo-preview` ができたら、Workers → 各 Worker → Settings → Domains & Routes で
   **Custom Domain** を追加(本番 `lingo.example.com`、preview `lingo-preview.example.com`)。
2. 同じ画面で **workers.dev** と **Preview URLs** が Disabled になっていることを確認(`wrangler.jsonc` で `workers_dev: false` / `preview_urls: false`)。
3. Version URL も含め、カスタムドメイン以外から到達できないこと(あるいは Access 配下であること)を確認。

**(d) API token**(My Profile → API Tokens → Create Custom Token)
- 権限: Account → **Workers Scripts: Edit**、Account → **D1: Edit**、Account → **Account Settings: Read**(wrangler の account 解決用)。
  Custom Domain をこの token で付けるなら Zone → **Workers Routes: Edit** を対象 zone に限定して追加(手で付けるなら不要)。
- Account Resources = 自分のアカウントのみ。TTL は任意(期限を付けるならカレンダーに更新予定を入れる)。
- 本番用と preview 用で分けても良い(分けない場合は同じ値を両 Environment に登録)。

### GitHub 側

**(e) Environments**(Settings → Environments)
- `production` と `preview` を作り、どちらも **Required reviewers = 自分**、Deployment branches は `production` を `main` のみに制限(preview は制限なし = PR head を出すため)。
- Variables: `APP_URL`(production = `https://lingo.example.com`、preview = `https://lingo-preview.example.com`。末尾スラッシュなし)。

**(f) Secrets**(各 Environment の Environment secrets。Repository secrets には置かない)

| 名前 | 中身 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | (d) の token |
| `CLOUDFLARE_ACCOUNT_ID` | ダッシュボード右側の Account ID |
| `ACCESS_TEAM_DOMAIN` | チーム名(`myteam` でも `myteam.cloudflareaccess.com` でも可) |
| `ACCESS_AUD` | その Environment のドメインの Access アプリの AUD |
| `ALLOWED_EMAIL` | 自分のメール |

### (g) 完了条件の確認

1. **preview** workflow を `ref=main` で起動 → 承認 → 成功し、Summary に URL が出る(= 非本番 D1 `lingo-db-preview` への migration と接続ができた)。
2. **release** workflow を `ref=main` で起動 → 承認 → 疎通まで成功。artifact に D1 バックアップがある。
3. 本番ドメインで以下を確認:
   - ブラウザ(未ログイン)で開く → Access のログイン画面。`curl -i https://lingo.example.com/` → 302(Access)。
   - 偽の JWT: `curl -i -H "Cf-Access-Jwt-Assertion: x" https://lingo.example.com/` → 302(Access が先に止める。
     Access を抜けた後の Worker 側の拒否 = 未認証・署名不正・期限切れ・別メール・設定欠落はテストで担保)。
   - **別メール**: 許可していないメールで OTP を要求 → コードが届かない / 拒否される。
   - **期限切れ**: Access アプリの Session Duration を一時的に 15m 等に短くし、期限後にリロード → 再ログインを求められる
     (古い `CF_Authorization` cookie を `curl -H "Cookie: CF_Authorization=<古い値>"` で送っても 403/302)。確認後に戻す。
   - 自分のメールでログイン → 「lingo」が表示される。`/api/health` は未ログインでも `{"ok":true,...}`。
4. `https://lingo.<account>.workers.dev` が到達不能(404 / 無効)であること。
5. 上記を確認したら Issue 0 を閉じる。

## 運用メモ

- merge は本番ではない。本番は release workflow(承認必須)でだけ変わる。
- release の前に D1 を export して artifact に残す(90 日)。本番データ投入前に「空 DB へ復元」の試験を 1 回やる(設計書 §2)。
- 非本番 D1 は 1 本を共有する。schema 変更を伴う PR の preview は直列に(concurrency `preview` で同時実行はしない)。
