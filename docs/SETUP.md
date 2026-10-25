# lingo 基盤セットアップ手順書(Issue #1 / 設計書 §6 Issue 0)

GitHub と Cloudflare をほとんど使ったことがない人向けに、画面のどこを開き、何を押し、何を入力し、何を控えるかを 1 操作 1 行で書いています。
README の「人がやる基盤作業」(a)〜(g) をこの順番に並べ直したものです。

## 先に読む約束

- **token・秘密の値はチャット(Claude を含む)に貼らないでください。** Cloudflare の画面でコピーし、GitHub の画面に直接貼ります。
- チャットに貼ってよいのは **D1 の database_id だけ**です(秘密ではありません)。
- 控えた値は末尾の「控えたもの一覧」表に書き込みます。token と AUD はパスワードマネージャに控え、リポジトリのファイルには書かないでください。
- Cloudflare と GitHub の画面は頻繁に名前が変わります。この手順書の名前と違うときは「(表記が違う場合は近い名称を探す)」のとおり、近い名前のメニューを探してください。
- 例として `example.com` を「自分が Cloudflare に登録済みのドメイン」として書いています。自分のドメインに読み替えてください。
- コマンドは PC のターミナル(PowerShell でも Git Bash でも可)で実行します。wrangler はグローバルに入れず、毎回 `pnpm dlx wrangler@latest ...` で実行します。

## 全体の流れ

| # | 内容 | 場所 | 目安 |
|---|---|---|---|
| 0 | ドメイン名を決める・wrangler login・Account ID | PC / ブラウザ | 10 分 |
| 1 | D1 を 2 本作る | PC | 5 分 |
| 2 | Zero Trust(Access)の初期設定 | Cloudflare | 10 分 |
| 3 | Access アプリを作る(本番・preview 各 2 個) | Cloudflare | 20 分 |
| 4 | API token を作る | Cloudflare | 5 分 |
| 5 | GitHub Environments を作る | GitHub | 10 分 |
| 6 | GitHub Secrets を入れる | GitHub | 10 分 |
| 7 | `wrangler.jsonc` に D1 の ID を入れる | Claude に依頼 | 5 分 |
| 8 | 初回デプロイとカスタムドメイン接続 | GitHub / Cloudflare | 20 分 |
| 9 | 完了条件の確認 | ブラウザ / PC | 15 分 |
| 10 | トラブル時 | — | — |

---

## 0. 準備(ドメイン名・wrangler login・Account ID)

**所要時間の目安**: 10 分
**終わったら控えるもの**: 本番ドメイン、preview ドメイン、Account ID

### 0-1. 使うドメイン名を決める

- 前提: Cloudflare のダッシュボード(https://dash.cloudflare.com)にログインし、トップの一覧(Account Home / Websites など)に自分のドメインが **Active** で表示されていること。
- 本番ドメイン = `lingo.<自分のドメイン>`(例 `lingo.example.com`)。
- preview ドメイン = `lingo-preview.<自分のドメイン>`(例 `lingo-preview.example.com`)。
- 確認: そのドメインを開く → 左メニュー **DNS** → **Records** で、`lingo` と `lingo-preview` という名前のレコードが**まだ無い**こと(あると手順 8 のカスタムドメイン追加で衝突します)。
- 控える: 本番ドメイン、preview ドメイン。

### 0-2. wrangler でログインする(PC)

| どこ | 操作 |
|---|---|
| PC のターミナル | `pnpm dlx wrangler@latest login` を実行する |
| 自動で開いたブラウザ | Cloudflare のログイン画面が出たらログインする |
| 権限の確認画面 | 内容を確認して **Allow**(許可)を押す |
| ブラウザ | 「You have granted authorization to Wrangler」のような完了表示が出たらタブを閉じてよい |
| ターミナル | `Successfully logged in.` が出ていることを確認する |

- ブラウザが開かない場合は 10 章「wrangler login がブラウザを開かない」を参照。

### 0-3. Account ID を控える

| どこ | 操作 |
|---|---|
| PC のターミナル | `pnpm dlx wrangler@latest whoami` を実行する |
| 出力 | 表の `Account Name` と `Account ID` の列を探す |
| 控える | `Account ID`(32 桁の英数字) |

- ダッシュボードでも確認できます: ドメインを開いた画面の右側(API の欄)、または Workers & Pages の概要画面の右側に **Account ID** があります(表記が違う場合は近い名称を探す)。

---

## 1. D1 を 2 本作る(ターミナル)

**所要時間の目安**: 5 分
**終わったら控えるもの**: 本番 D1 の database_id、preview D1 の database_id

- リポジトリのフォルダの**外**(例 ホームフォルダ)で実行してください。リポジトリ内で実行すると wrangler が「設定ファイルに追記しますか」と聞いてくることがあり、その場合は **No** で答えます(追記は手順 7 で行います)。

| どこ | 操作 |
|---|---|
| ターミナル | `pnpm dlx wrangler@latest d1 create lingo-db` を実行する |
| 質問が出た場合 | 場所(location)を聞かれたら Enter(自動)でよい。設定ファイルへの追記を聞かれたら **No** |
| 出力 | 下の例の `"database_id": "..."` の行を探す |
| 控える | その `database_id` の値(本番用) |
| ターミナル | `pnpm dlx wrangler@latest d1 create lingo-db-preview` を実行する |
| 控える | 同様に `database_id` の値(preview 用) |

出力の例(形は版によって少し違います。見るのは `database_id` の行だけ):

```
✅ Successfully created DB 'lingo-db' in region APAC
{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "lingo-db",
      "database_id": "0a1b2c3d-1111-2222-3333-444455556666"   ← これを控える
    }
  ]
}
```

- 控え忘れたら: `pnpm dlx wrangler@latest d1 list` で一覧(名前と UUID)が出ます。
- ダッシュボードでは **Storage & databases → D1 SQL database**(表記が違う場合は近い名称を探す)に 2 本並んでいれば OK。

---

## 2. Cloudflare Zero Trust(Access)の初期設定

**所要時間の目安**: 10 分
**終わったら控えるもの**: Team domain(`<名前>.cloudflareaccess.com`)

| どこ | 操作 |
|---|---|
| https://dash.cloudflare.com | ログインし、アカウントのトップ(ドメイン一覧の画面)を開く |
| 左メニュー | **Zero Trust** を押す(新しいタブで Zero Trust のダッシュボード one.dash.cloudflare.com が開くことがある) |
| 初回だけ: チーム名の画面 | 「Team name」/「Team domain」の入力欄に好きな名前を入れる(例 `luca-lingo`)。`<名前>.cloudflareaccess.com` になる |
| 初回だけ: プラン選択 | **Free**(0 ドル、50 ユーザーまで)を選ぶ |
| 初回だけ: 支払い情報 | 無料プランでも支払い方法の登録を求められる場合がある。必要なら**自分で**入力する(0 ドルのプランなので請求は発生しない) |
| 完了 | Zero Trust の概要画面(Overview / Home)が開けば OK |
| 控える | Team domain(`<名前>.cloudflareaccess.com` の全体) |

- 既に Zero Trust を使ったことがある場合: Zero Trust の **Settings**(設定)→ **Team name and domain**(表記が違う場合は Settings の **General** や **Custom Pages** の中)に Team domain が表示されています。

### 2-1. ログイン方法に「メールのワンタイム PIN」があることを確認

| どこ | 操作 |
|---|---|
| Zero Trust の左メニュー | **Settings** → **Authentication**(新しい画面では **Integrations → Identity providers**。表記が違う場合は近い名称を探す) |
| Login methods の一覧 | **One-time PIN** があるか見る |
| 無い場合 | **Add new**(追加)→ **One-time PIN** を選ぶ → **Save** |

- One-time PIN = ログイン画面でメールアドレスを入れると、そのアドレスに 6 桁のコードが届く方式です。

---

## 3. Access アプリを作る(Self-hosted)

**所要時間の目安**: 20 分
**終わったら控えるもの**: 本番の AUD Tag、preview の AUD Tag

### 考え方(先に読む)

- Access のポリシー(誰を通すか)は **アプリ単位**で効きます。1 つのアプリの中で「このパスだけ Bypass」とポリシーを分けることは**できません**(ポリシーはアプリの全パスに効く)。
- 代わりに **パスを指定した 2 個目のアプリ** を作ります。Access は「より具体的なパスを持つアプリ」を優先するので、`lingo.example.com/api/health` だけが Bypass、それ以外は 1 個目のアプリ(自分のメールだけ Allow)になります。
- 作るアプリは合計 4 個です。

| アプリ名 | ドメイン | パス | ポリシー |
|---|---|---|---|
| `lingo` | 本番ドメイン | (空 = 全体) | `me`(Allow、自分のメール) |
| `lingo-health` | 本番ドメイン | `api/health` | `health-bypass`(Bypass、Everyone) |
| `lingo-preview` | preview ドメイン | (空 = 全体) | `me` |
| `lingo-preview-health` | preview ドメイン | `api/health` | `health-bypass` |

- 新しい画面では「ポリシーを先に作ってアプリから選ぶ」方式(再利用できるポリシー)です。古い画面ではアプリ作成の途中でポリシーを作ります。どちらでも結果は同じです。以下は新しい画面に沿って書き、古い画面の場合を括弧で添えます。
- 自信が持てない場合の確認方法: 手順 9 の 3・8 の行(`/` はログイン画面、`/api/health` はログイン無しで JSON)が両方成り立てば、パスの優先が正しく効いています。

### 3-1. ポリシーを 2 つ作る

| どこ | 操作 |
|---|---|
| Zero Trust の左メニュー | **Access controls → Policies**(古い画面では **Access → Policies**。無ければ 3-2 の途中で作る) |
| ボタン | **Add a policy**(または **Create new policy**) |
| Policy name | `me` |
| Action | **Allow** |
| Session duration | `24 hours`(既定のままでよい) |
| Add rules → Include | Selector に **Emails** を選び、Value に自分のメールアドレスを入れる |
| ボタン | **Save** |
| ボタン | もう一度 **Add a policy** |
| Policy name | `health-bypass` |
| Action | **Bypass** |
| Add rules → Include | Selector に **Everyone** を選ぶ |
| ボタン | **Save** |

### 3-2. 本番の本体アプリ `lingo`

| どこ | 操作 |
|---|---|
| Zero Trust の左メニュー | **Access controls → Applications**(古い画面では **Access → Applications**) |
| ボタン | **Add an application** |
| 種類の選択 | **Self-hosted** を選ぶ(Select) |
| Application name | `lingo` |
| Session Duration | `24 hours`(既定でよい) |
| Public hostname(古い画面では Application domain) | **Add public hostname** を押し、Subdomain に `lingo`、Domain に自分のドメインを選ぶ。Path は**空**のまま |
| Access policies | **Select existing policies** で `me` を選ぶ(古い画面では次のページで新規作成: 名前 `me` / Action Allow / Include → Emails → 自分のメール) |
| Login methods(認証の画面) | **One-time PIN** が含まれていることを確認(「Accept all available identity providers」がオンならそのままでよい) |
| ボタン | **Next** で進み、最後に **Save**(または **Add application**) |

### 3-3. 本番の AUD Tag を控える

| どこ | 操作 |
|---|---|
| Applications の一覧 | `lingo` の行の **…**(三点)→ **Edit**、または名前を押す |
| 画面 | **Overview** タブ(新しい画面では **Basic information** や **Additional settings** の欄。表記が違う場合は近い名称を探す) |
| 項目 | **Application Audience (AUD) Tag**(64 桁の英数字)の右のコピーボタンを押す |
| 控える | 本番の AUD Tag(秘密扱い。チャットには貼らない) |

### 3-4. 本番の health 用アプリ `lingo-health`(Bypass)

| どこ | 操作 |
|---|---|
| Applications | **Add an application** → **Self-hosted** |
| Application name | `lingo-health` |
| Public hostname | Subdomain `lingo`、Domain = 自分のドメイン、**Path に `api/health`**(入力欄の前に `/` が表示されているので先頭のスラッシュは不要) |
| Access policies | `health-bypass` を選ぶ(古い画面では名前 `health-bypass` / Action **Bypass** / Include → **Everyone** で新規作成) |
| ボタン | **Next** → **Save** |

- このアプリの AUD は使いません(控えなくてよい)。

### 3-5. preview 用の 2 個

- 3-2〜3-4 を、ドメインを preview に変えて繰り返します。

| アプリ | 入力の違い |
|---|---|
| `lingo-preview` | Subdomain `lingo-preview`、Path 空、ポリシー `me` |
| `lingo-preview-health` | Subdomain `lingo-preview`、Path `api/health`、ポリシー `health-bypass` |

- 控える: `lingo-preview` の **AUD Tag**(本番とは別の値になります)。

### 3-6. この時点での確認

- まだ Worker もカスタムドメインも無いので、ブラウザで開いてもエラーになって構いません。確認は手順 9 で行います。
- Applications の一覧に 4 個並び、それぞれのドメインとパスが上の表どおりなら OK。

---

## 4. API token を作る

**所要時間の目安**: 5 分
**終わったら控えるもの**: API token(**1 回しか表示されません**)

### 必要な権限(release.yml / preview.yml を読んで確定したもの)

| workflow で実行するコマンド | 必要な権限 |
|---|---|
| `wrangler deploy` / `wrangler rollback`(Worker の更新・巻き戻し、workers.dev 無効化) | Account → **Workers Scripts** → **Edit** |
| `wrangler d1 export` / `wrangler d1 migrations apply`(本番・preview の D1) | Account → **D1** → **Edit** |
| wrangler がアカウント情報を読む | Account → **Account Settings** → **Read** |

- カスタムドメインは手順 8 で**手で**付けるので、Zone の権限(Workers Routes)は不要です。
- Access(Zero Trust)の権限も不要です(Access の設定は手順 3 で手で済ませています)。

### 操作

| どこ | 操作 |
|---|---|
| https://dash.cloudflare.com | 右上の人型アイコン → **My Profile**(表記が違う場合は **Profile**) |
| 左メニュー | **API Tokens** |
| ボタン | **Create Token** |
| 一番下 | **Custom token** の **Get started** を押す(テンプレートは使わない) |
| Token name | `lingo-github-actions` |
| Permissions 1 行目 | `Account` / `Workers Scripts` / `Edit` |
| **+ Add more** | `Account` / `D1` / `Edit` |
| **+ Add more** | `Account` / `Account Settings` / `Read` |
| Account Resources | `Include` / 自分のアカウント名(All accounts にしない) |
| Client IP Address Filtering | 空のまま(GitHub Actions の IP は固定できないため) |
| TTL | 任意。期限を付けるなら終了日を決め、カレンダーに「token 更新」を入れる |
| ボタン | **Continue to summary** → 内容を確認 → **Create Token** |
| 表示された token | **コピーボタン**を押す。この画面を閉じると二度と表示されない |
| 控える | token は**チャットに貼らず**、手順 6 まで画面を開いたままにするか、パスワードマネージャに一時保存する |

- 画面に表示される「test this token」の curl は実行してもよい(`"status": "active"` が返れば有効)。
- 本番と preview で token を分けても構いません。分けない場合は同じ token を両方の Environment に入れます。

---

## 5. GitHub Environments を作る

**所要時間の目安**: 10 分
**終わったら控えるもの**: なし(設定するだけ)

### 5-0. 前提: リポジトリの公開設定を確認

- **重要**: GitHub Free のアカウントでは、**private リポジトリでは Environments(承認・Environment secrets)が使えません**(Pro / Team 以上が必要)。2026-10-25 時点で `luca1016/lingo` は **private** です。
- 設計書 §8 は **public を推奨**しています(コードに秘密は無く、データは D1 側)。どちらにするか先に決めてください。

| どこ | 操作 |
|---|---|
| https://github.com/luca1016/lingo | 上部タブ **Settings** |
| General の一番下 | **Danger Zone** → **Change repository visibility** → **Change to public**(public にする場合。確認ダイアログの指示に従う) |
| public にした場合 | Issue #1 のとおり `runner/setup-repo.sh luca1016/lingo` を再実行する(ブランチ保護の設定) |

- private のままにする場合は、次の 5-1 の画面で **Required reviewers** が選べるか確認してください。選べなければ Pro 契約か public 化が必要です。

### 5-1. `production` を作る

| どこ | 操作 |
|---|---|
| リポの **Settings** | 左メニュー **Environments** |
| ボタン | **New environment** |
| Name | `production` → **Configure environment** |
| Deployment protection rules | **Required reviewers** にチェック → 入力欄に `luca1016` を入れて選ぶ |
| (あれば)Prevent self-review | **チェックしない**(自分で起動して自分で承認するため) |
| ボタン | **Save protection rules** |
| Deployment branches and tags | プルダウンを **Selected branches and tags** に変更 → **Add deployment branch or tag rule** → `main` を入力 → **Add rule** |
| Environment variables | **Add environment variable**(または **Add variable**) |
| Name / Value | `APP_URL` / `https://lingo.example.com`(本番ドメイン。**https:// 付き、末尾スラッシュなし**) → **Add variable** |

### 5-2. `preview` を作る

| どこ | 操作 |
|---|---|
| **Settings → Environments** | **New environment** |
| Name | `preview` → **Configure environment** |
| Deployment protection rules | **Required reviewers** にチェック → `luca1016` → **Save protection rules** |
| Deployment branches and tags | **No restriction** のまま(PR の head を出すため) |
| Environment variables | `APP_URL` / `https://lingo-preview.example.com`(preview ドメイン、末尾スラッシュなし) |

---

## 6. GitHub Secrets を入れる

**所要時間の目安**: 10 分
**終わったら控えるもの**: なし

- release.yml は Environment `production`、preview.yml は Environment `preview` の secrets を読みます。`ACCESS_AUD` は本番と preview で値が違うので、**全部 Environment secrets に入れます。Repository secrets(Settings → Secrets and variables → Actions の「New repository secret」)には置きません。**
- 値はブラウザで Cloudflare の画面や控えから**直接コピーして GitHub に貼ってください**。チャットには貼りません。

### 入れる 5 個と値の出所

| 名前 | production に入れる値 | preview に入れる値 | 出所 |
|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | API token | 同じ token(分けたなら preview 用) | 手順 4 |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID | 同じ | 手順 0-3 |
| `ACCESS_TEAM_DOMAIN` | Team domain(`<名前>.cloudflareaccess.com`。`<名前>` だけでも可) | 同じ | 手順 2 |
| `ACCESS_AUD` | `lingo` アプリの AUD | `lingo-preview` アプリの AUD | 手順 3-3 / 3-5 |
| `ALLOWED_EMAIL` | 自分のメールアドレス(手順 3-1 のポリシーと同じ) | 同じ | 手順 3-1 |

### 操作(Environment ごとに 5 回)

| どこ | 操作 |
|---|---|
| リポの **Settings → Environments** | `production` を押す |
| **Environment secrets** の欄 | **Add environment secret**(または **Add secret**) |
| Name | `CLOUDFLARE_API_TOKEN` |
| Value | token を貼る(前後に空白や改行を入れない) |
| ボタン | **Add secret** |
| 繰り返す | 残り 4 個(`CLOUDFLARE_ACCOUNT_ID` `ACCESS_TEAM_DOMAIN` `ACCESS_AUD` `ALLOWED_EMAIL`)も同様 |
| **Settings → Environments** | `preview` を押し、同じ 5 個を入れる(`ACCESS_AUD` だけ preview の値) |

- 入れたあとは値は見えません(名前と更新日時だけ表示)。間違えたら鉛筆アイコン(**Update**)で上書きします。
- 確認: `production` と `preview` の画面それぞれに、secrets 5 個と variable `APP_URL` 1 個が並んでいれば OK。

---

## 7. `wrangler.jsonc` に D1 の ID を入れる

**所要時間の目安**: 5 分
**終わったら控えるもの**: なし

- この作業は Claude に頼みます。チャットに次のように貼ってください(database_id は秘密ではないので貼ってよい):

```
lingo の wrangler.jsonc に D1 の ID を入れて PR にして
lingo-db:         <本番の database_id>
lingo-db-preview: <preview の database_id>
```

- Claude が `REPLACE_ME_PROD`(トップレベル)と `REPLACE_ME_PREVIEW`(`env.preview`)を置き換えた PR を作ります。
- PR の Checks(`test`)が緑になったら、PR 画面の **Merge pull request** → **Confirm merge** で main に入れます。
- **この merge が終わるまで手順 8 の release / preview は失敗します**(ID が `REPLACE_ME_*` のままのため)。

---

## 8. 初回デプロイとカスタムドメインの接続

**所要時間の目安**: 20 分
**終わったら控えるもの**: なし

### 8-1. 初回 release を 1 回実行する(Worker `lingo` を作るため)

| どこ | 操作 |
|---|---|
| https://github.com/luca1016/lingo | 上部タブ **Actions** |
| 左の workflow 一覧 | **release** |
| 右上 | **Run workflow** のプルダウン |
| Use workflow from | `Branch: main` |
| 昇格する ref | `main`(既定のまま) |
| ボタン | 緑の **Run workflow** |
| 一覧に出た実行 | 行を押して開く(数秒待つと出る) |
| 黄色の「Waiting for review」 | **Review deployments** を押す → `production` にチェック → **Approve and deploy** |
| 結果 | **初回は「疎通」ステップで失敗して構いません**(まだカスタムドメインが無く、`APP_URL` に届かないため)。`deploy` ステップまで緑なら Worker はできています |

- rollback ステップで「rollback に失敗(初回デプロイなど)」の warning が出るのも初回は正常です。

### 8-2. 初回 preview を 1 回実行する(Worker `lingo-preview` を作るため)

| どこ | 操作 |
|---|---|
| **Actions** → 左の **preview** | **Run workflow** |
| ref | `main` |
| pr | 空 |
| ボタン | **Run workflow** → 実行を開く → **Review deployments** → `preview` → **Approve and deploy** |
| 結果 | 同様に「疎通」で失敗して構いません。`deploy(preview)` まで緑なら OK |

- `wrangler deploy --env preview` で作られる Worker の名前は **`lingo-preview`** です(wrangler が `<name>-<env 名>` にする)。

### 8-3. 本番 Worker にカスタムドメインを付ける

| どこ | 操作 |
|---|---|
| https://dash.cloudflare.com | 左メニュー **Compute (Workers)** → **Workers & Pages**(表記が違う場合は **Workers & Pages** を探す) |
| 一覧 | **lingo** を押す |
| 上部タブ | **Settings** |
| **Domains & Routes** の欄 | **+ Add** |
| 種類 | **Custom domain** |
| Domain | `lingo.example.com`(本番ドメイン) |
| ボタン | **Add domain** |
| 状態 | 数分で証明書が発行され Active になる(DNS レコードは自動で作られる) |

### 8-4. preview Worker にカスタムドメインを付ける

| どこ | 操作 |
|---|---|
| **Workers & Pages** の一覧 | **lingo-preview** を押す |
| **Settings → Domains & Routes** | **+ Add** → **Custom domain** → `lingo-preview.example.com` → **Add domain** |

### 8-5. workers.dev と Preview URLs が無効か確認

| どこ | 操作 |
|---|---|
| **lingo** → **Settings → Domains & Routes** | `workers.dev` の行が **Disabled**(無効)であること |
| 同じ欄 | **Preview URLs** の行が **Disabled** であること |
| **lingo-preview** でも | 同じ 2 点を確認 |

- `wrangler.jsonc` に `workers_dev: false` / `preview_urls: false` が書いてあるので、デプロイのたびに無効へ戻ります。Enabled になっていたら 10 章を参照。

### 8-6. release と preview をもう一度実行する

- 8-1 と 8-2 をもう一度行い、今度は**全ステップ緑**になることを確認します(手順 9 の 1・2 を兼ねます)。

---

## 9. 完了条件の確認(README の (g))

**所要時間の目安**: 15 分
**終わったら控えるもの**: なし(Issue #1 のチェックを付ける)

| # | 確認 | 期待する結果 |
|---|---|---|
| 1 | preview workflow(ref `main`)が全ステップ緑 | Summary に `preview: https://lingo-preview.example.com (commit ...)` |
| 2 | release workflow(ref `main`)が全ステップ緑 | 実行画面下の **Artifacts** に `d1-backup-<SHA>` がある |
| 3 | **シークレットウィンドウ**(未ログイン)で `https://lingo.example.com/` を開く | Access のログイン画面(メールアドレス入力)になる |
| 4 | ターミナルで `curl -i https://lingo.example.com/` | `302` と `Location: https://<名前>.cloudflareaccess.com/...` |
| 5 | `curl -i -H "Cf-Access-Jwt-Assertion: x" https://lingo.example.com/` | 同じく `302`(Access が先に止める) |
| 6 | ログイン画面で**許可していない別のメール**を入れる | コードが届かない、または拒否される |
| 7 | ログイン画面で自分のメール → 届いた 6 桁のコードを入力 | 「lingo」が表示される |
| 8 | `curl https://lingo.example.com/api/health` | `{"ok":true,"version":"0.1.0","commit":"<SHA>"}` |
| 9 | `curl https://lingo-preview.example.com/api/health` | 同様に `{"ok":true,...}` |
| 10 | `curl -i https://lingo.<アカウントのサブドメイン>.workers.dev/` | 到達できない(404 やエラー) |
| 11 | `pnpm dlx wrangler@latest d1 execute lingo-db-preview --remote --command "select 1"` | 結果の表に `1` が出る |

- 11 はリポジトリの**外**で実行してください(リポジトリ内で実行するなら末尾に `--env preview` を付ける)。
- 10 のサブドメインは **Workers & Pages** の概要画面の右側(Subdomain)に出ています(表記が違う場合は近い名称を探す)。
- 期限切れの確認(README (g) 3): `lingo` アプリの Session Duration を一時的に `15 minutes` に変更 → ログイン → 15 分後にリロード → 再ログインを求められること → **確認後に `24 hours` に戻す**。
- 全部 OK なら Issue #1 のチェックを付けて閉じます。

---

## 10. トラブル時

| 症状 | 原因と対処 | 確認コマンド / 画面 |
|---|---|---|
| `wrangler login` でブラウザが開かない | ターミナルに表示された `https://dash.cloudflare.com/oauth2/auth?...` の URL を**同じ PC の**ブラウザに貼って開く。SSH 先の別ホストで実行すると戻り先(localhost:8976)に届かないので、必ず手元の PC で実行する | `pnpm dlx wrangler@latest whoami` |
| `whoami` に複数のアカウントが出る | 使うアカウントの Account ID を控える。D1 作成時に選択を聞かれたら同じものを選ぶ | `pnpm dlx wrangler@latest whoami` |
| AUD Tag が見つからない | Applications → `lingo` → **Edit** → **Overview**(または Basic information / Additional settings)。health 用アプリの AUD と取り違えていないか確認 | Zero Trust → Access controls → Applications |
| Actions の実行が黄色のまま進まない | 承認待ち。実行画面上部の **Review deployments** → Environment にチェック → **Approve and deploy** | Actions → 該当の実行 |
| Run workflow ボタンが無い | workflow ファイルが main に無い、または Actions が無効。**Settings → Actions → General** で Actions が許可されているか | Actions タブ |
| Required reviewers が選べない / Environment secrets が使えない | private リポ + Free プランのため。5-0 を参照(public にするか Pro) | Settings → Environments |
| `::error::XXX が未設定` で止まる | その Environment に secret / variable が無い。名前の綴り(大文字・アンダースコア)と、**Repository secrets ではなく Environment secrets** に入れたかを確認 | Settings → Environments → production / preview |
| `Authentication error [code: 10000]` | token の権限不足かアカウント違い。手順 4 の 3 権限と Account Resources を確認。`CLOUDFLARE_ACCOUNT_ID` が token のアカウントと一致しているか | My Profile → API Tokens → 該当 token → **Edit** |
| `/memberships` や `/user` で 403 が出る | wrangler がユーザー情報を読もうとしている。token に User → **Memberships: Read**(または User Details: Read)を追加して再実行(通常は Account ID を渡しているので不要) | 同上 |
| D1 で `database not found` や `REPLACE_ME` を含むエラー | 手順 7 の PR が main に入っていない。ref に `main` を指定したか | `git log origin/main -- wrangler.jsonc` |
| release / preview が「疎通」で落ちる(2 回目以降) | (1) カスタムドメインが Active でない → 8-3 / 8-4。(2) `/api/health` がログイン画面にリダイレクトされる → **Bypass アプリ未設定**、またはパス・ドメインの不一致(3-4 / 3-5)。(3) `APP_URL` の綴り・末尾スラッシュ | `curl -i https://lingo.example.com/api/health`(302 なら Bypass が効いていない、200 で JSON なら OK) |
| ログイン後に 403 になる | Worker 側の JWT 検証で拒否。`ACCESS_AUD` が別アプリ(health 用・preview 用)の値、`ACCESS_TEAM_DOMAIN` の綴り、`ALLOWED_EMAIL` がログインしたメールと違う、のどれか。secret を直して release を再実行 | Workers & Pages → lingo → **Logs**(Observability) |
| カスタムドメイン追加で「既にレコードがある」 | DNS に同名レコードがある。DNS → Records で `lingo` / `lingo-preview` を確認して整理してから追加 | ドメイン → DNS → Records |
| `workers.dev` が Enabled になっている | deploy が古い設定で走った可能性。main の `wrangler.jsonc` に `workers_dev: false` があることを確認して release を再実行 | Workers & Pages → lingo → Settings → Domains & Routes |
| ワンタイム PIN のメールが届かない | 迷惑メールフォルダを確認。2-1 で One-time PIN が有効か、3-2 で Login methods に含まれているか | Zero Trust → Settings → Authentication |

---

## 控えたもの一覧(値は自分で記入。token と AUD はここに書かずパスワードマネージャへ)

| # | 名前 | 出所(手順) | 入れる先 | 値 |
|---|---|---|---|---|
| 1 | 本番ドメイン | 0-1 | 3-2 / 3-4 / 5-1 `APP_URL` / 8-3 | |
| 2 | preview ドメイン | 0-1 | 3-5 / 5-2 `APP_URL` / 8-4 | |
| 3 | Account ID | 0-3 | secret `CLOUDFLARE_ACCOUNT_ID`(両 Environment) | |
| 4 | 本番 D1 database_id | 1 | 7(チャットに貼ってよい) | |
| 5 | preview D1 database_id | 1 | 7(チャットに貼ってよい) | |
| 6 | Team domain | 2 | secret `ACCESS_TEAM_DOMAIN`(両 Environment) | |
| 7 | 本番 AUD Tag | 3-3 | secret `ACCESS_AUD`(production) | (書かない) |
| 8 | preview AUD Tag | 3-5 | secret `ACCESS_AUD`(preview) | (書かない) |
| 9 | API token | 4 | secret `CLOUDFLARE_API_TOKEN`(両 Environment) | (書かない) |
| 10 | 許可するメール | 3-1 | secret `ALLOWED_EMAIL`(両 Environment) | |
