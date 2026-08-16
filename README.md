# aide

AIDE（エイド）— 生活情報まわりの共通バックエンド／ハブ。

Claudeアプリ等のLLMクライアントに対しては **MCPサーバー** として、既存の個人アプリに対しては **REST API** として、同じデータを提供する。

設計の背景・意思決定は Notion「[AIDE アーキテクチャ構想](https://app.notion.com/p/3ba506de73c381d58c03e0e7676d30b9)」を正本とする。ここにはコードを読むうえで必要な範囲だけ書く。

## 責務

AIDEがやること:

- 外部サービスからの**データ取得**（Zaim、GitHub、Google系、Notion 等）
- 必要な範囲への**フィルタリング**
- サービスごとに異なる形式の**共通フォーマットへの整形**
- 複数ソースを1回の呼び出しに畳んだ**横断ビュー**の提供

AIDEがやらないこと:

- **高コストなAI推論**。意味の解釈・優先順位付け・要約・文章生成は呼び出し側のLLMに渡す。AIDEは取得・選別・整形に徹する
- **公式MCPと重複する単機能ツールをMCP層に出すこと**（後述）

## Core と MCP層の境界

ここが設計上いちばん間違えやすい。**2つのレイヤーを分けて考える。**

| レイヤー | 対象 | 方針 |
|---|---|---|
| Core（`src/core/`） | Notion・Google系・Zaim・GitHub **すべて** | 公式APIを直接叩く。横断ビューとワーカーに必要なので**フルスコープ** |
| MCP層（`src/mcp/`） | 横断ビュー ＋ 公式MCPが無いもの **のみ** | Claudeアプリには既に公式MCPがある。`aide_get_calendar_events` のような単機能ツールを出すと同じ機能のツールが2セット並び、ツール選択が曖昧になりコンテキストも食う |

Core をフルスコープで作っておけば、MCP層で「出す／出さない」は後からいくらでも変えられる。判断を先送りできるので、**Core は広く、MCP層は狭く**始める。

## 取得と提供の分離

Playwright を使うZaim取得のような重い処理は **worker が定期実行してキャッシュに書き**、MCPサーバー／APIは**キャッシュを読むだけ**にする。

同期リクエスト中にヘッドレスChromiumを起動すると、応答に数十秒かかりメモリも跳ねる。VPSは2GBしかないため、この分離は必須。

- **VPS**: MCPサーバー / REST API / DB（軽量・常時・公開）
- **サブPC**: Playwright等の重いワーカー（16GB・断続・非公開）→ 結果をHTTPSでVPSへ送る

### どこまでを「重い取得」とみなすか

分離が要るのは**重い取得**であって、あらゆる取得ではない。キャッシュを挟むと必ずジョブ間隔ぶん
古くなるため、鮮度そのものが価値であるデータに機械的に適用すると答えが悪くなる。

| | 分離する | 都度叩く |
|---|---|---|
| 例 | Zaim巡回（Playwright・十数秒・メモリが跳ねる） | ops-dashboard（localhostへのHTTP GET・数ミリ秒） |
| 判断 | 同期リクエストに載せるとVPSが持たない | 載せても問題なく、キャッシュのほうが害になる |

都度叩く場合は**短いタイムアウトを必ず掛ける**（相手が落ちてもMCPツールが固まらないように）。
到達できなかったことは握りつぶさず、状態として返す。

## 構成

```
src/
  server.ts            エントリポイント。/mcp と /api を1プロセスで提供
  mcp/
    transport.ts       Streamable HTTP transport
    registry.ts        ツール登録簿
    tools/             MCPツール
  api/
    ingest.ts          worker からの取得結果の受け口（POST /api/cache/:key）
    read.ts            個人アプリ向けの読み取りAPI（GET /api/money/summary）
    secret.ts          /api 配下の共有シークレット認証
  core/
    connectors/        外部サービスからの取得
    models/            共通データモデル
    views/             横断ビュー
  web/                 人間向けのHTMLページ（機能一覧）
  worker/              定期実行ジョブ
```

プロセスを1本に絞っているのはメモリ制約のため。パッケージ分割（monorepo化）は規模が育ってから検討する。

## 開発

Node 24 以降が必要（`.ts` を型ストリッピングで直接実行するため、トランスパイル不要）。

```bash
npm run dev     # node --watch src/server.ts
npm start
npm run typecheck
```

デフォルトで `127.0.0.1:4747` を listen する。`PORT` / `HOST` で変更可。

### Claudeアプリから使う

ローカルの4747を、既存の `dev-tunnel`（Cloudflare Tunnel）経由で公開している。

| | |
|---|---|
| 開発用URL | `https://aide-dev.minagu.work/mcp` |
| tunnel設定 | `~/.cloudflared/config.yml` の ingress。**catch-all より前**に置くこと |
| 起動 | `cloudflared tunnel run dev-tunnel` |

ClaudeアプリのカスタムコネクタにこのURLを登録する。**末尾の `/mcp` が要る。**

接続元はAnthropicのサーバーであり利用者の端末ではないため、**公開到達性が必要**。Tailscaleのみのホストには置けない。

トラブル時:

- **エッジが404を返す** — cloudflaredが `~/.cloudflared/config.yml` を自動で読むため、`--url` を渡してもingressが優先され catch-all に落ちている。一時的なトンネルなら `--config` に空のconfigを渡す
- **登録は成功するのに配送されない** — QUIC（UDP 7844）が塞がれている。`--protocol http2` で回避

## MCPツール

| ツール | 内容 |
|---|---|
| `aide_ping` | 疎通確認。サーバー時刻とセッションIDを返す |
| `aide_money_summary` | 資産・残高の現況。キャッシュを読むだけで取得はしない。取得時刻と経過分数を併せて返す |
| `aide_ops_status` | VPS・サブPCの稼働状況。ops-dashboard の読み取りAPIを都度叩いて「いま異常があるか」の粒度に畳む |
| `aide_dev_status` | 各リポジトリの開発状況。最新リリース・未リリースの差分・Issue/PR・確認待ち・直近コミット・CIの成否。`repo` を指定すると1リポジトリの詳細 |


## 機能一覧ページ

`GET /features` で、このサーバーで使える機能（MCPツール・HTTPエンドポイント・workerジョブ）を
一覧表示する。デプロイ済みのAIDEに何が載っているかをブラウザから確認するためのもの。

実体は `src/web/features.ts`。MCPツールは登録簿から自動生成するため、ツールを増やせば何もしなくても
載る。**HTTPエンドポイントだけは静的な宣言**なので、`src/server.ts` にルートを足したら
`ENDPOINTS` も更新する。

**このページは認証なしで公開する。** 載せてよいのは「どんな機能が存在するか」という静的なカタログ
だけで、キャッシュの中身・取得時刻などの実データ、環境変数の値、認証の有効・無効は載せない。
掲載範囲はOAuthのディスカバリメタデータ（`/.well-known/...`）で既に公開されている情報を超えない。

`/` は404のままにしている。


## コネクタ: Zaim

Zaimは残高取得の公式APIが無いため、Playwrightで画面を巡回して取得する。**AIDEが存在する理由そのもの**にあたるコネクタ（公式MCPも公式APIも無い領域）。

```
src/core/connectors/zaim/
  parse.ts       生テキスト → 数値化（純粋関数。テストはここに集中する）
  scrape.ts      子プロセスで巡回スクリプトを起動する
  scripts/       Playwright本体（子プロセスとして実行）
    login.mjs        初回の手動ログイン。storage state を保存する
    scrape.mjs       残高＋証券詳細ページの巡回
    keep-alive.mjs   セッション延長のみ（軽量）
```

### 前提

Playwrightは**AIDEの依存に含めない**。実行環境へグローバル導入する。

```bash
npm install -g playwright && playwright install chromium
```

package-lock を肥大化させず、ブラウザ実行環境をアプリ本体から分離するため。

### 初回セットアップ

ID・パスワードは保存しない。GUIのある端末で一度だけ手動ログインし、storage state を保存する。

```bash
node src/core/connectors/zaim/scripts/login.mjs
```

保存先は既定で `data/zaim/storage-state.json`（**リポジトリ基準**。カレントディレクトリ相対にするとワーカーからの実行時にずれる）。中身はCookieそのものなので `data/` ごと gitignore している。

### セッション

Zaimの認証Cookieは数時間で失効するが、巡回のたびにその時点から延長される。**取得間隔を失効時間より短く保てば手動ログインは不要**。取得を行わない期間は `keep-alive.mjs` で延長だけする。

失効した場合は自動回避せず `ZAIM_SESSION_EXPIRED` で失敗させ、手動ログインをやり直す。CAPTCHAや追加認証を突破しにいかないための方針。

### 呼び出し方

`scrapeZaimSnapshot()` はヘッドレスChromiumを起動するため**数十秒かかる**。MCPやAPIの同期リクエストから直接呼んではいけない。worker から定期実行してキャッシュに書き、参照側はキャッシュを読む。

### asset-manager との境界

| | 置き場所 | 理由 |
|---|---|---|
| 巡回・パース | **AIDE** | 「取得」そのもの。他アプリからも再利用する |
| `Category.valuationAlias` との照合、評価額への反映 | **asset-manager** | 資産管理固有のドメインロジック |
| 同期を実行できるユーザーの制限 | **asset-manager** | asset-manager の認証・ユーザーモデルに紐づく |

asset-manager は巡回結果を[読み取りAPI](#個人アプリ向けの読み取りapi)（`GET /api/money/summary`）から受け取る。


## コネクタ: ops-dashboard

VPS・サブPCの稼働状況。**AIDEは指標を集めない。** [ops-dashboard](https://github.com/guchi-apps/ops-dashboard)
が既にホスト指標・外形監視・AI/GitHub/1Password の残枠を集約しているため、その読み取りAPIを叩いて
1本のMCPツール（`aide_ops_status`）に畳むだけにしている。

Zaimと違い「公式APIが無いから自分で取りに行く」ケースではなく、**既にある集約を横断ビューへ畳む**
ケースにあたる。ここで指標収集を作り直すと ops-dashboard と二重になる。

```
src/core/connectors/ops-dashboard/
  types.ts   ops-dashboard のレスポンスのうち、AIDEが使うフィールドだけを再宣言
  index.ts   6本のGETを並行で叩く。1本落ちても他を巻き込まない
src/core/views/ops.ts        しきい値判定と圧縮（summarizeOps は純粋関数。テストはここ）
```

### 経路

両方とも同じVPS上で動くため **localhost で届き、ops-dashboard を外部公開する必要がない**。
`fetch` しか使わないので実行時依存も増えない。方式はaide#27と同じ。

| 環境変数 | 未設定のとき | 設定したとき |
|---|---|---|
| `AIDE_OPS_DASHBOARD_URL` | `http://127.0.0.1:3110` | そのURLへ問い合わせる |
| `AIDE_OPS_DASHBOARD_TOKEN` | 取得を試みず「未設定」を返す | `Authorization: Bearer` で認証する |

トークンは**認証情報として扱う**。ログにもMCPのレスポンスにも出さない。取得失敗の理由は
HTTPステータスと例外の種別まで丸める（例外の `message` にはURLが載るため）。

**ops-dashboard 側の読み取りAPIは元々ログインセッション必須**で、サーバー間用のトークン認証は
[ops-dashboard#85](https://github.com/guchi-apps/ops-dashboard/issues/85) で追加する。それが入るまで
401 を受けるため、このツールは「取得できなかった」を返す（AIDE側は先行してマージしてよい）。

### 返す粒度

「いま異常があるか」に答えられるところまで。**24時間分の履歴・上位プロセス・tmuxセッションの名前や
作業ディレクトリ・全ディスクマウントは返さない。** 生の指標をそのまま渡してもコンテキストを食うだけで
答えは良くならない。詳細を見たいときは ops-dashboard の画面がある。

`problems` に異常が1行ずつ入り、これだけ読めば答えられるようにしている。しきい値は
`src/core/views/ops.ts` の `THRESHOLDS` にまとめてある（残枠の 15% / 35% は ops-dashboard 側の
`remainingTone()` と揃えてある）。

**オフラインのホストでは指標を評価しない。** 最後に受け取った値をそのまま判定すると、落ちる直前の
CPU 100% を「いま高負荷」として報告してしまう。

`ok`（判定できた範囲で異常なし）と `complete`（全ソースを取得できた）は別に返す。1本だけ落ちるケース
（1Password CLIが無い等）は普通に起きるため、全体を失敗にすると「他は正常だった」という情報まで失う。


## コネクタ: GitHub

各リポジトリの開発状況。ClaudeアプリにはGitHubのコネクタが無い（接続済みは Notion・Gmail・
Googleカレンダー・Googleドライブ・AIDE）ため、GitHubは「Core と MCP層の境界」でいう
**公式MCPが無いもの**にあたる。Zaimと同じ位置づけ。

```
src/core/connectors/github/
  types.ts   GraphQLレスポンスのうちAIDEが使うフィールドだけ再宣言
  query.ts   クエリ。取得内容は RepoStatus フラグメント1つに集約している
  index.ts   POST /graphql と、失敗理由の丸め
src/core/views/dev.ts        対象の選別と圧縮（summarizeDev は純粋関数。テストはここ）
```

### AIDEを唯一の取得口にはしない

GitHub取得は既に3実装ある。**AIDEはこれらを置き換えない。**

| リポジトリ | 用途 |
|---|---|
| `issue-deck` | GitHub Appでの認証、Issue/PR操作、Actions、webhook。**書き込みを伴う** |
| `ops-dashboard` | Actions残枠 |
| `portfolio` | 公開用のリポジトリ情報取り込み |

issue-deck はGitHub Appの認証・webhook受信・書き込みが本体で、AIDE経由にすると往復が増えるだけ。
AIDEが持つのは**読み取り専用の横断ビュー**に限る。

### 返す粒度

**状態の俯瞰まで。ソースコードやREADMEの本文は返さない**（aide#32 で確定）。ファイル取得の
ツールは追加しない。返す量が大きくなるうえ「MCP層は狭く」の方針とぶつかる。コードの詳細は
Claude Code（CLI）とissue-deckが担当する。

ツールは**1本だけ**（`aide_dev_status`）。「全体の俯瞰」と「1リポジトリの詳細」を別ツールに割ると
ツール選択が曖昧になるため、引数 `repo` の有無で深さを切り替えている。

`attention` に注意点が1行ずつ入り、これだけ読めば答えられるようにしている。しきい値は
`src/core/views/dev.ts` の `DEFAULTS` にまとめてある。

### RESTではなくGraphQLを使う理由

対象が26リポジトリあり、RESTだと**同じ内容に約80リクエスト**かかる（リポジトリごとに
compare・releases・commits・issues）。GraphQLなら**1リクエスト・実測2ポイント**で済む
（上限は1時間5000ポイント）。`fetch` で `POST /graphql` するだけなので実行時依存も増えない。

### 落とし穴

- **`compare` の向きが直感に反する。** `defaultBranchRef.compare(headRef:"main")` は
  base=デフォルトブランチ / head=main なので、**`behindBy` が「未リリースのコミット数」**に
  あたる（`aheadBy` は main 側だけにあるコミット数）。RESTの `compare/main...develop` の
  `ahead_by` と一致することを確認済み。テストで固定してある
- **`main` が無いリポジトリでは `compare` が NOT_FOUND を返す。** `master` 運用のリポジトリで
  普通に起きる安定した状態なので、取得失敗として数えない（数えると `complete` が恒久的に
  false になり、本物の失敗が埋もれる）
- **詳細モードで組織全体を引かない。** 全リポジトリを深く掘るクエリはGitHub側の処理が重く、
  実測で5秒のタイムアウトに掛かった。コストではなく応答時間の問題。1リポジトリだけを引く
  クエリに分けてある（約1秒）
- 俯瞰は実測3〜4秒かかる（うち `compare` だけで約1.4秒）。タイムアウトは10秒に取っている

### 設定

| 環境変数 | 未設定のとき |
|---|---|
| `AIDE_GITHUB_TOKEN` | 取得を試みず「未設定」を返す |
| `AIDE_GITHUB_ORG` | `guchi-apps` |
| `AIDE_GITHUB_REPOS` | archived を除き、直近 `AIDE_GITHUB_ACTIVE_DAYS` 日にpushがあったものを自動で拾う |
| `AIDE_GITHUB_ACTIVE_DAYS` | `90` |

トークンは**認証情報として扱う**。ログにもMCPのレスポンスにも出さない。取得失敗の理由は
HTTPステータスと例外の種別まで丸める。GraphQLの `errors` も `message` は載せず、
どのリポジトリのどのフィールドかと種別だけを返す（`message` に内部の構成が載ることがあるため）。

fine-grained PAT を使う。必要な権限は Metadata / Contents / Issues / Pull requests / Actions の
**read のみ**。GitHub App は採らなかった（読み取り専用の用途に対して、秘密鍵の保管と
JWT署名→インストールトークン交換の実装が重い）。

キャッシュは挟まず**都度叩く**。1リクエストで済み、レート制限にも余裕があり、
「いまどうなっているか」という問いに対してキャッシュの古さは害にしかならない。


## キャッシュと worker

取得と提供を分離するための仕組み。

```
src/core/cache/store.ts    JSONファイルのキャッシュ
src/worker/run.ts          ジョブのエントリポイント（ワンショット実行）
src/worker/jobs/           個々のジョブ
src/core/views/            キャッシュを読んで横断ビューを組み立てる
```

### なぜキャッシュを挟むか

Zaimの巡回は12秒前後かかる。MCPやAPIの同期リクエストの中で走らせると、応答が遅いうえにヘッドレスChromiumのぶんメモリが跳ねる。VPSは2GBしかないため成立しない。

worker が定期実行して `data/cache/` に書き、MCPサーバーとAPIはそれを読むだけにする。

### JSONファイルである理由

データモデルがまだ固まっていない。この段階でDBを入れると、形を変えるたびにマイグレーション運用のコストが先に来る。形が安定したらMariaDBへ移す。

書き込みは一時ファイル + `rename` で行う。直接上書きすると、書き込み中に読まれたときに壊れたJSONを掴む。

### ジョブの実行

```bash
npm run worker zaim-sync        # 巡回してキャッシュ更新（重い、日次想定）
npm run worker zaim-keep-alive  # セッション延長のみ（軽い、毎時想定）
```

常駐させずワンショットで実行し、スケジューリングは外（cron / systemd timer / PM2）に任せる。常駐プロセスを増やさずに済み、失敗しても次回実行で自然に復旧する。失敗時は終了コード1を返すので、スケジューラ側から検知できる。

### 実行間隔の制約

Zaimの認証Cookieは**約2時間**で失効し、アクセスのたびにその時点から延長される。したがって **2時間以内に必ず1回はZaimへアクセスする必要がある**。

| ジョブ | 間隔 | 理由 |
|---|---|---|
| `zaim-keep-alive` | 毎時 | 有効期間2時間に対して2倍の余裕を取る |
| `zaim-sync` | 日次 | 資産評価額は日次で足りる。Zaimへのアクセスを無駄に増やさない |

**このスケジューリングは常時起動のホストに置く必要がある。** 開発機（メインPC）は常時起動しない前提のため、セッションを維持できない。本番では subpc が担う。

### ジョブ失敗の通知

終了コード1は systemd のジャーナルに残るだけで誰にも届かない。実際に `aide-zaim-sync.service` の失敗が丸一日気づかれずに放置されたため、失敗を [Signaly](https://github.com/guchi-apps/signaly)（Webhook受信 + Web Push の通知ハブ）へ送っている（`src/worker/notify.ts`）。

| 環境変数 | 未設定のとき | 設定したとき |
|---|---|---|
| `AIDE_SIGNALY_WEBHOOK_URL` | 通知しない（開発機） | 失敗・復旧をそのWebhookへ送る（本番 = サブPC） |

URLに含まれる `channel_id` が宛先の識別子そのもの（Webhook自体は認証なし）なので、**認証情報として扱う**。ログにも通知本文にも出さない。

送るのは次の2つだけ。

- **失敗**: ジョブ名・失敗理由・発生時刻・実行ホストを載せる。`ZAIM_SESSION_EXPIRED` の場合は手動ログインをやり直すまで直らないため、タイトルと「対応」欄で他の失敗と区別できるようにしている
- **復旧**: 失敗が記録されている状態で成功したときに1回だけ

日次の成功は送らない。`zaim-keep-alive` は毎時なので、成功も送ると1日24件になり肝心の失敗が埋もれる。

**同じ理由で失敗し続けている間は6時間に1回まで**に抑えている（毎時の `zaim-keep-alive` がセッション失効すると、抑制しないと24件/日届く）。理由が変わった場合は抑制せずに送る。抑制で黙っている状態と直った状態を区別できるように、復旧通知だけは出している。

未解決の失敗は `data/worker/notify-state.json` に持つ（ジョブ名・失敗理由の署名・時刻・回数だけ。取得データも認証情報も入れない）。**通知の送信失敗でジョブを二重に失敗させない。** 送信・記録まわりの例外はすべて握りつぶし、ログに一行残すだけにする。送れなかった回は通知済みにせず、次の実行で送り直す。

**プロセスが起動する前に落ちるケース（node が起動しない・OOMで強制終了）は拾えない。** そこまで拾うなら systemd の `OnFailure=` が要る。ユニットはこのリポジトリの外（サブPCの `~/.config/systemd/user/`）にある。

### 金額の扱い

`balances`（残高一覧）には証券口座の**合計**が含まれ、`holdings`（保有銘柄）はその**内訳**にあたる。両者を足すと証券分を二重に数えるため、横断ビューでは合算値を出していない。


## worker とサーバーが別マシンである問題

本番では **worker はサブPC、MCPサーバーはVPS**で動く。別マシンなのでキャッシュファイルを共有できない。放置すると worker が更新するキャッシュとサーバーが読むキャッシュが別物になり、Claudeへ古いデータを返し続ける。

worker から HTTP で送る形で解消している。

```
サブPC                          VPS
worker ──POST /api/cache/:key──▶ サーバー ──▶ data/cache/
```

| 環境変数 | 未設定のとき | 設定したとき |
|---|---|---|
| `AIDE_INGEST_URL` | ローカルのキャッシュへ直接書く（開発機） | そのURLへHTTPで送る（本番） |
| `AIDE_INGEST_SECRET` | — | 送信・受信の共通シークレット |

同じコードが開発機（両方ローカル）と本番（別マシン）の両方で動く。

**`AIDE_INGEST_URL` だけ設定して `AIDE_INGEST_SECRET` が無い場合はジョブを失敗させる。** 黙ってローカルへ書くと「送ったつもりで届いていない」状態になり、気づくのが遅れるため。

### 受け口の認証

MCPのOAuthとは別系統で、共有シークレット1本。呼び出し元が自分のworkerに限られるためOAuthは過剰で、issue-deck の dispatch と同じ方式に揃えている。

受け入れるキーはサーバー側で明示的に限定している（任意のキーで書き込めると、参照側が読まないゴミが溜まる）。


## 個人アプリ向けの読み取りAPI

Claudeアプリ等へMCPで出しているのと同じデータを、既存の個人アプリへはRESTで出す。実装は `src/api/read.ts`。

| | |
|---|---|
| エンドポイント | `GET /api/money/summary` |
| 返す内容 | `aide_money_summary` と同じ横断ビュー（`buildMoneySummary()`） |
| 認証 | `Authorization: Bearer $AIDE_READ_SECRET` |

```bash
curl -s -H "Authorization: Bearer $AIDE_READ_SECRET" http://127.0.0.1:3114/api/money/summary
```

```jsonc
{
  "empty": false,
  "fetchedAt": "2026-08-16T03:00:00.000Z",
  "ageMinutes": 120,
  "stale": false,
  "totals": { "balances": 1234567, "holdings": 234567 },
  "balances": [{ "name": "〇〇銀行", "amount": 1000000 }],
  "holdings": [{ "account": "〇〇証券", "name": "〇〇インデックス", "amount": 234567,
                 "occurrence": 1, "occurrenceCount": 1 }],
  "note": "..."
}
```

**取得時刻と経過分数を必ず併せて返し、鮮度の判断は呼び出し側に委ねる。** MCP層と同じ方針で、AIDEは
「古いから返さない」という判断をしない。キャッシュが空でも200を返す（`empty: true`）。まだ一度も巡回して
いないのは状態であってエラーではなく、呼び出し側が区別できる形で伝わればよい。

### キャッシュを素で返さない理由

`GET /api/cache/:key`（書き込みと対称な形）ではなく横断ビューを出している。外へ見せる契約が1本で済み、
キャッシュの構造を後から変えられる余地が残る。素で返す口は、必要になった時点で足す。

### 読み取りと書き込みでシークレットを分ける

`AIDE_READ_SECRET` は `AIDE_INGEST_SECRET` とは**別の値**にする。同じ値を使うと、読みたいだけのアプリへ
キャッシュの書き込み権限まで渡すことになる。未設定なら読み取り口は503を返し、そもそも開かない。

### 公開範囲

呼び出し元（asset-manager 等）は同じVPS上で動くため、**`http://127.0.0.1:3114` で叩く**。外向けのURLを
経由する必要はない。

ただし `/api` を丸ごと外部から遮断することはできない。worker はサブPCから `POST /api/cache/:key` を
外向けURLへ送るためで、Apacheで絞るなら `/api/money` だけを対象にする。


## 認証

ClaudeアプリからリモートMCPサーバーへ接続するための OAuth 2.1 を実装している。認可サーバーとリソースサーバーを同一プロセスに置いている（利用者が1人で、分ける利点がないため）。

### 起動時に必ず決まる

**`AIDE_AUTH_PASSWORD` が未設定だと起動しない。** 認証なしのまま公開してしまう事故を、設定ミスではなく起動失敗として顕在化させるため。

無効にするには `AIDE_AUTH_DISABLED=1` を明示する。その場合は起動時に警告を出す。

### Claudeが叩くパス

実測（2026-08-14）で判明した順序。**404を返すとClaudeは無認証のまま接続を継続してしまう**ため、必ず応答する。

```
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-protected-resource
/.well-known/oauth-authorization-server
```

未認証で `/mcp` を叩かれた場合は、401 と `WWW-Authenticate: Bearer resource_metadata="..."` を返す。このヘッダが無いとClaudeはディスカバリを始めない。

### フロー

動的クライアント登録（RFC 7591）→ 認可コード + PKCE（S256必須）→ トークン。
クライアントは動的登録のため `client_secret` を持たない。その代わりに PKCE を必須にしている。

利用者の認証はパスワード1つ。凝った作りにすると壊れるうえ、利用者が1人なら得るものが無い。

### トークン

不透明なランダム文字列で、サーバー側で照合する。JWTと違い**即座に失効させられる**ことを優先した。

```bash
rm data/auth/oauth-state.json   # 全トークンを即時失効
```

有効期限はアクセストークン30日・リフレッシュトークン180日と長い。個人利用で再認証の手間を避けるためで、上記の失効手段があることが前提。リフレッシュはローテーションする（使ったリフレッシュトークンは無効化する）。

### 総当たり対策

公開URL上に単一パスワードのフォームを晒すため、回数制限を入れている。

| 対象 | 制限 |
|---|---|
| 認可（パスワード） | 失敗ごとに約0.7秒待つ。15分間に5回失敗で15分ロック（`Retry-After` を返す） |
| 動的クライアント登録 | 送信元ごとに1時間20件まで |

ロックは**送信元ごと**に独立している。全体で1つにすると、第三者が失敗を繰り返すだけで正規利用者を締め出せる。送信元の判定は `X-Forwarded-For` の先頭を優先する（プロキシ配下では socket のアドレスが全リクエストで同じになり、制限が機能しないため）。

状態はプロセス内メモリに置く。再起動で消えるが、試行のたびにディスクへ書くと、書き込み負荷でサービスを劣化させる材料を与えることになる。

**登録エンドポイントは仕様上（RFC 7591）未認証で公開される。** 無制限に受け付けると状態ファイルが際限なく膨らむため、ここにも上限を設けている。

### 設計上の注意

- **`redirect_uri` が登録内容と一致しない場合、そこへリダイレクトしない。** エラーもクライアントへ返さず認可画面で止める。緩めるとオープンリダイレクトになる
- **パスワード照合は長さが違っても同じ経路を通す。** 早期returnすると処理時間からパスワード長を推測される
- **公開URLはリバースプロキシのヘッダから解決する。** Apache や cloudflared の背後ではHostが公開名と異なる。メタデータのURLがずれるとクライアントが別ホストへ飛んで認証が壊れる

### 既知の未整理

Claudeは `Anthropic/Toolbox` と `Anthropic/ClaudeAI` の2クライアントで接続するため、再接続のたびに登録が積み上がる。実害は無いが、肥大化したら同一 `client_name` + `redirect_uri` の再利用を入れる。


## 本番

| | |
|---|---|
| ポート | 3114（vps README の予約済みポートに登録済み） |
| 想定ドメイン | `aide.gucchii.com` |
