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
- **他のどこからも塞がっている経路に限った書き込み**（後述。現在はGitHubのIssue起票と、Zaimへの支出登録の2つ）

AIDEがやらないこと:

- **高コストなAI推論**。意味の解釈・優先順位付け・要約・文章生成は呼び出し側のLLMに渡す。AIDEは取得・選別・整形に徹する
- **公式MCPと重複する単機能ツールをMCP層に出すこと**（後述）
- **他のアプリが既に持っている書き込み経路の置き換え**（後述）

### 書き込みをどこまで持つか

AIDEは元々**取得専用**として作った。書き込みを足すかは Issue ごとに判断せず、次の3条件を
**すべて**満たすものに限る（aide#50 で確定。aide#37 以降の判断もこれに従う）。

1. **他のどこからも塞がっている経路であること。** 既存のアプリ・公式MCP・Claude Code から
   できることは、AIDEに口を作らない（往復が増えるだけになる）
2. **読み取りとは別の資格情報を使うこと。** 取得用のトークンに書き込み権限を足さない
3. **作成だけを持つこと。** 編集・削除・状態の変更は持たない。取り返しのつく操作に限る

現在この基準で入れている書き込みは次の2つ。

| | 経路 | 条件1 | 条件2（資格情報） | 条件3 |
|---|---|---|---|---|
| `aide_create_issue`（aide#50） | ClaudeアプリからのGitHub Issue起票 | 満たす | `AIDE_GITHUB_ISSUE_TOKEN`（取得用とは別のPAT） | 作成のみ |
| `POST /api/zaim/payment`（aide#37） | 個人アプリからZaimへの支出登録 | **例外**（下記） | Zaim APIの OAuth 1.0a（巡回の storage state とは別） | 作成のみ |

#### Zaimへの登録は条件1の例外（aide#37）

Zaim の `POST /v2/home/money/payment` は**公開APIで、car-care / asset-manager から直接叩ける**。
「他のどこからも塞がっている経路」ではないため、条件1は文言どおりには満たしていない。
それでもAIDEへ寄せたのは、塞がっているからではなく **Zaimの資格情報を1か所に閉じ込めるため**。
各アプリがそれぞれZaimクライアントと認証情報を持つと、読み取り側で起きた重複（asset-manager#191）を
書き込み側でも作ることになる。条件2・3は文言どおり満たしている。

**この例外を前例として使わない。** 「経路は開いているが資格情報を分散させたくない」という形の要望は
他のサービスでも出うるので、次に持ち込むときはこの節を根拠にせず、Issueで改めて決める。

詳細は[個人アプリ向けのZaim登録API](#個人アプリ向けのzaim登録api)。

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
| 例 | Zaim巡回（Playwright・十数秒・メモリが跳ねる） | ops-dashboard・subscription-lists（localhostへのHTTP GET・数ミリ秒） |
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
    zaim.ts            個人アプリ向けのZaim登録API（POST /api/zaim/payment）
    secret.ts          /api 配下の共有シークレット認証
  core/
    connectors/        外部サービスからの取得
    models/            共通データモデル
    views/             横断ビュー
  web/                 人間向けのHTMLページ（機能一覧・動作状況）と共通レイアウト
  worker/              定期実行ジョブ
```

プロセスを1本に絞っているのはメモリ制約のため。パッケージ分割（monorepo化）は規模が育ってから検討する。

## 開発

Node 24 以降が必要（`.ts` を型ストリッピングで直接実行するため、トランスパイル不要）。

```bash
npm run dev     # node --watch --env-file-if-exists=.env src/server.ts
npm start
npm run typecheck
```

デフォルトで `127.0.0.1:4747` を listen する。`PORT` / `HOST` で変更可。

**`.env` は Node 標準の `--env-file-if-exists` で読ませている。** `AIDE_AUTH_PASSWORD` が未設定だと
サーバーは起動を拒否するため、読ませないと `.env` に書いてあっても起動しない（本番のPM2も
`node_args` で同じ指定をしている）。

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
| `aide_money_summary` | 資産・残高と月額固定費の現況。残高・保有銘柄はキャッシュを読むだけ（取得時刻と経過分数を併せて返す）、固定費は subscription-lists を都度叩く |
| `aide_ops_status` | VPS・サブPCの稼働状況。ops-dashboard の読み取りAPIを都度叩いて「いま異常があるか」の粒度に畳む |
| `aide_room_status` | いまの部屋の状態。myroom の読み取りAPIを都度叩き、センサーごとの室温・湿度・気圧・CO2・照度、エアコンの運転状態、屋外との気温差に畳む |
| `aide_daily_briefing` | 今日1日の見通し。今日の予定・交通・今日と明日の天気を1回に畳む。**ソースごとに独立して失敗する**（取れたものだけ返る） |
| `aide_dev_status` | 各リポジトリの開発状況。最新リリース・未リリースの差分・Issue/PR・確認待ち・直近コミット・CIの成否。`repo` を指定すると1リポジトリの詳細 |
| `aide_create_issue` | GitHubのIssueを新規作成する。**書き込みを伴う唯一のツール**（作成のみ。編集・close・コメントは持たない） |


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

## アイコンとPWAマニフェスト

`src/web/icons/` に置いたPNGを `GET /icons/<名前>` で返し、`GET /manifest.webmanifest` で
ホーム画面へ追加したときの名前とアイコンを返す（どちらも認証は不要）。ブラウザが `<link>` の
有無によらず取りにくる `/favicon.ico` にも、同じ32px版のPNGを返している。

**実行時に画像を加工しない。** 依存ゼロを保つため画像処理ライブラリを入れておらず、必要な
サイズ（512 / 192 / 180 / 32）をあらかじめ縮小してコミットしてある。差し替えるときは同じ
サイズのPNGを作り直して `src/web/icons/` を置き換える（`src/web/assets.ts` の `ICONS` に載って
いるものがマニフェストにもそのまま出る）。元画像は Issue #80 の添付。

サイズが宣言とずれていないかは `src/web/assets.test.ts` がPNGのIHDRを直接読んで確かめている。


## 動作状況ページ

`GET /status` で、AIDE自身がいま正しく動いているかを表示する。それまでは、Claudeに `aide_ping` を
聞くかVPSのログを見るしか確かめる手段が無かった。

| | |
|---|---|
| 載せるもの | 全体の判定と対応すべきこと、サーバー（稼働時間・バージョン・認証の有無）、定期ジョブの最後の実行、キャッシュの鮮度と件数、接続先の設定状況、MCPの登録クライアント数・トークン数、MCPへのアクセスの記録 |
| 載せないもの | 残高の金額、シークレットの値、Zaimのログイン状態 |
| 認証 | 許可したGoogleアカウント（`AIDE_STATUS_ALLOWED_EMAILS`）。Supabase未設定の環境では `AIDE_AUTH_PASSWORD`。`AIDE_AUTH_DISABLED=1` なら素通しし、画面上で警告を出す |

**機能一覧（`/features`）とは公開範囲が正反対。** あちらは認証なしで公開する代わりに静的なカタログ
しか載せない。こちらは実データを載せるためログインの内側に置く。見た目は共通
（`src/web/layout.ts`）だが、**この境界は混ぜない。**

判定そのものは `src/core/views/health.ts` が持ち、表示（`src/web/status.ts`）は並べ方と色だけを決める。
しきい値を変えるときはビュー側だけを見ればよい。

### MCPへのアクセスの記録

Claudeアプリからの呼び出しは、これまでどこにも残らなかった。ジョブの失敗は Signaly へ飛び
（`src/worker/notify.ts`）、実行の記録はキャッシュに残る（`src/worker/record.ts`）のに、
**MCPだけは「いつ・どのツールが呼ばれたか」を後から確かめる手段が無かった**（#116）。
`/mcp` のやり取り1件につき1行を残し、このページの「MCPアクセス」へ新しい順で出す。

| | |
|---|---|
| 残すもの | 時刻・メソッド（認証で弾いた場合は `auth`）・ツール名・名乗ったクライアント名とバージョン・成否・失敗理由1行・所要ミリ秒 |
| 残さないもの | **ツールの引数と応答の中身**、アクセス元IP、アクセストークン、セッションID |
| 置き場 | `data/mcp-access.json`（直近200件。書き込みは2秒ぶんまとめて行う） |

**残高や部屋の状態を記録に含めない。** 含めると、MCPが返すデータの置き場をもう1つ増やすのと
変わらなくなる。画面に出せるのも「いつ・誰が・どのツールを・成功したか」までで、中身が要るときは
Claudeに聞くことになる。

置き場をキャッシュ（`src/core/cache/store.ts`）にしていないのは、あちらが worker からHTTPで届く
取得結果の置き場で、受け口（`POST /api/cache/:key`）から上書きできるため。記録を書くのはサーバー
自身なので、経路を共有する理由が無い。メモリ上だけに持つ案は、デプロイのたびに空になり
「最後にClaudeが繋いだのはいつか」に答えられなくなるため採らなかった。

**認証で弾いたアクセスも1行残す。** `/mcp` はトークンが無ければ `requireBearer()` が401を返して
そこで終わり、`src/mcp/transport.ts` までは届かない（`src/server.ts`）。ここを記録しないと、
**Claudeのトークンが切れて呼び出しが全部落ちている状態**と、誰も繋いでいない状態が画面上で
区別できない。ただし `/mcp` は公開されている口なので、叩かれ続けたぶんは1分に1件へ落とす。

**上限を超えた分は「接続確認・一覧の取得 → 認証で弾いたもの → 残り」の順に捨てる。** 単純に古い順で
捨てると、Claudeが定期的に投げてくるぶんや外から叩かれた認証失敗が並んだだけで、いちばん見たい
ツールの呼び出しが押し出される。枠を分けずに優先順位だけで守るのは、片方が空でももう片方に
使えるようにするため。画面でも接続確認・一覧の取得の行は既定で畳んであり、チェックを入れたときだけ
同じ表に混ざる。

記録に失敗してもMCPの応答は変えない（`src/mcp/access-log.ts`）。実行記録と同じ方針で、記録の
失敗だけで成功した呼び出しが失敗扱いになるのを避ける。

### ページを開いても外部へ問い合わせない

材料はすべて手元にあるもの（キャッシュ・実行記録・環境変数の有無）で済ませている。開くたびに
ops-dashboard や GitHub を叩くと、相手が落ちているだけで画面が開かなくなる。疎通の確認は
「疎通を確認する」を押したときだけ `POST /status/checks` として走る。

**Zaim は疎通確認の対象外。** ログインは Playwright を使う重い処理で、巡回は worker の仕事にしてある。

### worker 側の設定は「未設定」と断定しない

本番では worker がサブPC、サーバーがVPSで動き、**`.env` が別**（`deploy.yml` がVPSへ書くのは
`AIDE_*` の一部だけで、`ZAIM_*` と `AIDE_SIGNALY_WEBHOOK_URL` は含まれない）。サーバー側の
環境変数を見て判定すると、正しく動いていても常に「未設定」と出る。

そのため接続先には `side`（`server` / `worker`）を持たせ、**worker 側は判定せず「worker側」と表示する。**
実際に動いているかは、定期ジョブの実行記録で分かる。

### ログインは許可したGoogleアカウントだけ

ログインには他アプリ（dayspan・shopping-list）と同じ共有SupabaseプロジェクトのGoogleログインを使い、
`AIDE_STATUS_ALLOWED_EMAILS` に挙げたメールアドレスの人だけを通す（`src/auth/supabase.ts`）。
実データを載せる画面をパスワード1本の内側に置くと、漏れても気づけず、誰が開いたかも残らない。

`@supabase/supabase-js` は入れず、Auth の REST（`/auth/v1/authorize` と
`/auth/v1/token?grant_type=pkce`）を fetch で直接叩いている。**実行時依存ゼロの方針**（後述）と、
必要なのが認可URLの組み立てとコードの交換だけであるため。**Supabase側のセッションは保持しない。**
身元が分かった時点で失効させ、以降は自前のCookieだけで通す。

| 環境変数 | 内容 |
|---|---|
| `AIDE_SUPABASE_URL` | 共有SupabaseプロジェクトのURL |
| `AIDE_SUPABASE_PUBLISHABLE_KEY` | 同プロジェクトの公開鍵（旧 anon key） |
| `AIDE_STATUS_ALLOWED_EMAILS` | 画面を開いてよいメールアドレス（カンマ区切り） |

**3つとも設定するか、3つとも空にするかのどちらかで、半端な状態は起動時に落とす。** 許可メールだけが
空だと「Googleアカウントがあれば誰でも開ける」状態になるため。3つとも空なら従来どおり
`AIDE_AUTH_PASSWORD` でのログインになり、その場合は `POST /status/login` も生きている。
**Googleログインが有効な環境では、パスワードでのログインは受け口ごと無効になる**（404）。
残すと、メールアドレスで絞った意味がパスワード1本で消える。

### 戻り先URLの登録ずれは、起動時とその画面から検知する

Supabaseダッシュボードの Authentication > URL Configuration > Redirect URLs に、
AIDEの戻り先を登録しておく必要がある。**ここが一致しないとき、Supabase（GoTrue）はエラーを返さず
プロジェクトの Site URL へ静かに倒す。** ログインは「成功したのに別のアプリの画面が開く」という形で
壊れ、devtoolsで302先を1文字ずつ見比べるまで原因が分からなかった（#93）。認証基盤は他アプリと
共用のため、AIDEが何も変えていなくても他アプリ側の変更で許可リストが書き換われば同じことが起きる。

照合の規則が直感に反する。**フラグメントだけを落とし、クエリは付いたまま glob で照合される**
（GoTrue の `utilities.IsRedirectURLValid`）。AIDEの戻り先は CSRF 対策の `state` を載せた
`<AIDE_BASE_URL>/status/auth/callback?state=<乱数>` なので、**パスだけを完全一致で登録しても通らない。**
末尾に `**` を付けた形で登録する。

```
https://aide.gucchii.com/status/auth/callback**
```

（Site URL と scheme・ホスト・ポートが一致する戻り先は許可リストを見ずに通るため、Site URL が
AIDEのものであるプロジェクトではこのずれは起きない。共有プロジェクトの Site URL は別アプリのもの。）

一致しているかは `src/auth/redirect-check.ts` が確かめる。`GET /auth/v1/verify` に**成立しない
トークン**を渡すと、GoTrue は `/auth/v1/authorize` とまったく同じ判定関数で戻り先を決めてから
エラーのリダイレクトを返すため、`Location` に「実際に採用された戻り先」がそのまま出る。
許可リストの中身そのものを読むには Management API とアカウント全体に及ぶ Personal Access Token が
要るが、**欲しいのは一覧ではなく「AIDEの戻り先が通るか」なので、既にある公開鍵だけで足りる**
この経路を採った。成立しないトークンなのでセッションもメール送信も起こらない。

確認は2か所で走る。

- **起動時に1回**（`AIDE_BASE_URL` があるときだけ）。結果はログに出し、**起動は止めない。**
  Googleログインが壊れていると `/status` に入れず画面側の確認にも辿り着けないため、
  そのときに気づける場所はログしかない
- **`/status` の「疎通を確認する」ボタン**（`supabase-redirect`）。他の接続先と並べて表示する

### セッションはOAuthとは別系統

ログインした結果はCookie1つで持つ（`src/web/session.ts`）。MCPのOAuthに載せると画面を開くたびに
認可コードの往復が要る。**Cookieには署名だけを入れ、サーバー側に状態を持たない。**
Googleログインならメールアドレスを、パスワードでのログインなら身元なしを入れ、**メールアドレスも
署名の対象に含める**（含めないと署名の合う値の宛先だけ書き換えて別人を名乗れる）。
許可リストとの照合はCookieを出すときだけでなく**開くたびに行う**ので、リストから外せば
発行済みのCookieもその場で通らなくなる。

**署名鍵はパスワードから導かない。** 導くと、Cookieを1つ手に入れた相手がオフラインで
パスワードを総当たりでき、回数制限（オンライン試行にしか効かない）を迂回されてしまう。しかも
そのパスワードはClaudeアプリの接続認可と同じ1本なので、被害がこの画面の閲覧に留まらない。
鍵は `data/auth/status-session-key` に独立した乱数を1つ持つ（600で作る）。

```bash
rm data/auth/status-session-key   # 画面のログインを全部失効させる
```

総当たり対策は認可画面と同じ仕組み（`src/auth/ratelimit.ts`）を共有する。守っている
パスワードが同じである以上、片方だけ無制限に試せると回数制限が意味を失う。


## コネクタ: Zaim

Zaimは残高取得の公式APIが無いため、Playwrightで画面を巡回して取得する。**AIDEが存在する理由そのもの**にあたるコネクタ（公式MCPも公式APIも無い領域）。

```
src/core/connectors/zaim/
  parse.ts       生テキスト → 数値化（純粋関数。テストはここに集中する）
  scrape.ts      子プロセスで巡回スクリプトを起動する
  retry.ts       再試行と自動再ログインの「判断」（純粋関数。テストはここ）
  session.ts     子プロセスの起動と、失敗時の回復（再試行・自動再ログイン）
  scripts/       Playwright本体（子プロセスとして実行）
    login.mjs        初回の手動ログイン。storage state を保存する
    auto-login.mjs   ID・パスワードによる自動ログイン（任意機能）
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

GUIのある端末で一度だけ手動ログインし、storage state を保存する。

```bash
node src/core/connectors/zaim/scripts/login.mjs
```

保存先は既定で `data/zaim/storage-state.json`（**リポジトリ基準**。カレントディレクトリ相対にするとワーカーからの実行時にずれる）。中身はCookieそのものなので `data/` ごと gitignore している。

### セッション

Zaimの認証Cookieは**約2時間**で失効するが、アクセスのたびにその時点から延長される。つまり**維持できるかどうかは「2時間以内に1回でも成功したか」だけで決まる**。取得を行わない期間は `keep-alive.mjs` で延長だけする。

**この「1回でも成功したか」が曲者で、単発の失敗がそのままセッション喪失になっていた**（#63）。以前は `zaim-keep-alive` が毎時1回きり・再試行なしで、最悪間隔が1時間5分あった。2026-08-16 に瞬間的なネットワーク断（`net::ERR_ADDRESS_UNREACHABLE`）で1回落ち、次の実行が2時間1分後になった時点で失効している。いまは次の3段で守っている。

| 段 | 何をするか | どこ |
|---|---|---|
| 再試行 | 一時的な失敗（ネットワーク断・タイムアウト等）を最大3回・合計40秒の待ちでやり直す | `retry.ts` / `session.ts` |
| 間隔の余裕 | 30分ごと（揺らぎ2分）に回し、最悪間隔を32分にする。3回続けて失敗しても2時間に間に合う | `deploy/systemd/` |
| 自動再ログイン | 失効を検知したら、資格情報がある場合だけ**1度だけ**ログインし直してやり直す | `auto-login.mjs` |

**セッション失効は再試行しない。** やり直しても同じ結果になるため、`isRetriableZaimFailure()` で切り分けて即座に次の手（自動再ログイン）へ移る。

#### 失効の判定は「ログイン画面へ飛ばされたか」で見る

Zaimは未ログインでもHTTPエラーを返さず、SSO（`id.kufu.jp`）のログイン画面へ飛ばす。判定は
`scripts/session-check.mjs` の1か所に集約し、**飛び先のURLとパスワード入力欄の有無**だけで見る。

**本文の文言では判定しない。** 以前は「ログイン／メールアドレス／パスワード」を含み、かつ
「残高／総残高／評価額」を含まないことを失効の条件にしていたが、**金額を載せないページでは
ログイン済みでも失効と誤判定する。** 連携口座一覧（`/online_accounts`）がまさにそれで、
`zaim-refresh` はボタンを押した30秒後の確認で必ず失敗し、「手動ログインが必要」という誤った
通知だけが届いていた（#89）。連携口座の最終更新が何日も進まない原因になる。

### 自動再ログイン（任意機能）

`ZAIM_EMAIL` と `ZAIM_PASSWORD` の**両方**が設定されている環境でだけ有効になる。片方だけの設定は設定漏れとみなし、未設定として扱う。

- 未設定なら従来どおり `ZAIM_SESSION_EXPIRED` で失敗させ、手動ログインをやり直す。**開発機・CIではこちらが既定**
- **CAPTCHAや追加認証を突破しにいかない方針は変えていない。** `auto-login.mjs` は追加認証を検知したら素直に失敗し、呼び出し側は元の `ZAIM_SESSION_EXPIRED` を投げ直す。通知は従来どおり「手動ログインが必要」として届く
- 自動再ログインは**1回きり**。ログインし直しても失効するなら（資格情報が古い等）諦める。ログインと失効を往復させないため
- 資格情報の値は `session.ts` では読まない（設定の有無だけを見る）。子プロセスへ環境変数として渡し、ログ・通知・例外メッセージには出さない

値の正は1Passwordに置くが、**実行時に1Password CLIは呼ばない**（#1）。worker が動くサブPCの `.env` へ人が転記する。VPS側には要らない（VPSはキャッシュを読むだけ）。

ログイン画面は `id.kufu.jp` のSSOで構成が変わりうるため、セレクタは `ZAIM_LOGIN_EMAIL_SELECTOR` / `ZAIM_LOGIN_PASSWORD_SELECTOR` / `ZAIM_LOGIN_SUBMIT_SELECTOR` で上書きできる。未設定なら `type` / `name` 属性から総当たりで探す。

### 呼び出し方

`scrapeZaimSnapshot()` はヘッドレスChromiumを起動するため**数十秒かかる**。MCPやAPIの同期リクエストから直接呼んではいけない。worker から定期実行してキャッシュに書き、参照側はキャッシュを読む。

### 連携口座の更新（巡回の前に押す）

**Zaimの連携口座は「データを更新する」を押すまで、各金融機関から再取得されない。** 押さないまま巡回すると、その日の資産額として古い残高が記録される。`zaim-refresh` ジョブが `https://zaim.net/online_accounts` のボタンを押し、完了を待ってから `zaim-sync` が巡回する（#62）。

| | 押し方・判定 |
|---|---|
| ボタン | `form[action="/online_accounts/renewal"] button[type=submit]`。**クラス名はCSS Modulesのハッシュ付きでZaimのデプロイごとに変わる**ため使わない |
| 確認ダイアログ | `data-confirm` によるネイティブダイアログが出る。**Playwrightの既定は dismiss** なので `page.on("dialog", (d) => d.accept())` が必須（無いと押しても必ずキャンセルされる） |
| 完了判定 | Zaim側に完了のシグナルは無い。口座ごとの「最終更新」が進んだかで判定する。反映まで5〜15分 |
| 打ち切り | 連携設定が壊れている口座は何度押しても進まないため、全口座の完了は待てない。**しばらくどの口座も進まなくなったら打ち切る**（最短5分・静穏3分・上限15分） |

#### 「最終更新」はブラウザのタイムゾーンで描かれる

Zaimは連携口座の最終更新を**クライアント側で**描画するため、表示される日時はヘッドレス
Chromiumのタイムゾーンに従う。**subpc のシステムTZはUTCなので、指定しないと9時間ずれる。**
取り込み側（`parse.ts`）は表示文字列をJSTとして解釈し「当日（JST）に更新されたか」を見るので、
ずれると当日更新できた口座まで「更新できなかった口座」として通知される（#89）。

コンテキストの共通設定（`scripts/context.mjs`）で `timezoneId: "Asia/Tokyo"` に固定し、
`newContext` を呼ぶスクリプトが全部それを渡していることをテストで縛っている。表示の日付形式は
Zaim側が決めているため `locale` は指定しない。

画面の確認は `ZAIM_REFRESH_DRY_RUN=1` で行う。**ボタンを押さず**に、いま読めている口座と最終更新を出力するだけになる（押すとZaimが実際に各金融機関へ取得しにいくため、確認のたびに押さないで済むようにしてある）。

```bash
ZAIM_REFRESH_DRY_RUN=1 node --env-file-if-exists=.env src/core/connectors/zaim/scripts/refresh.mjs
```

### 更新できない口座の扱い

連携先のAPIキーの権限エラーや金融機関側のログイン期限切れで、**何度押しても更新できない口座が残る**（Zaim側の連携設定を直すまで解消しない）。AIDEはこれを次のように扱う。

- **古い残高を捨てたり書き換えたりしない。** 取得した事実だけを持つのがAIDEの責務で、当日値として記録するかの判断は asset-manager 側にある
- 代わりに口座ごとの最終更新を持たせる。`balances` / `holdings` の `lastUpdatedAt` と、連携口座の一覧 `onlineAccounts`（いずれもJSTオフセット付きのISO8601）
- `GET /api/money/summary` は最終更新が当日でない口座を `staleAccounts` にまとめ、`note` にも断りを入れる。**捨てるか使うかは呼び出し側が決める**
- `lastUpdatedAt` は**AIDEが巡回した時刻（`fetchedAt`）とは別物**。巡回が新しくても中身が何ヶ月も前ということがある
- 更新できない口座が出たら Signaly へ通知する（[ジョブ失敗の通知](#ジョブ失敗の通知)）。ジョブ自体は成功扱いのまま

### asset-manager との境界

| | 置き場所 | 理由 |
|---|---|---|
| 巡回・パース | **AIDE** | 「取得」そのもの。他アプリからも再利用する |
| 連携口座の更新（ボタン押下）と最終更新の取得 | **AIDE** | Zaimへ取りに行く経路そのもの。取得結果に「いつのものか」を添えるところまで |
| 最終更新が当日でない口座の残高を記録するか | **asset-manager** | 「その日の資産額として何を採るか」は資産管理側の判断 |
| `Category.valuationAlias` との照合、評価額への反映 | **asset-manager** | 資産管理固有のドメインロジック |
| 同期を実行できるユーザーの制限 | **asset-manager** | asset-manager の認証・ユーザーモデルに紐づく |

asset-manager は巡回結果を[読み取りAPI](#個人アプリ向けの読み取りapi)（`GET /api/money/summary`）から受け取る。

### 取得は巡回、登録は公式API

同じZaimでも、**読む経路と書く経路はまったく別**にしている。混同すると、片方の資格情報で
もう片方を動かそうとして詰まる。

| | 取得（残高・保有銘柄） | 登録（支出） |
|---|---|---|
| 手段 | Playwrightでの画面巡回 | 公式API（`POST /v2/home/money/payment`） |
| 資格情報 | ログイン状態（storage state。Cookieそのもの） | OAuth 1.0a（`AIDE_ZAIM_*`） |
| 動く場所 | サブPCの worker | VPSのサーバー（同期リクエスト内） |
| 実装 | `scrape.ts` / `parse.ts` / `session.ts` | `oauth.ts` / `write.ts` |

**Zaim APIで扱えるのは利用者が手入力したレコードだけ**という制約があり、残高も取れない。
だから取得は巡回のまま残している。逆に登録はAPIで素直にできるため、Playwrightを持ち出さない
（同期リクエスト中にChromiumを起動しないという「取得と提供の分離」の方針とも合う）。

銀行・カード・スマートレシート由来の**自動連携レコードはAPIから見えず、編集もできない**。
既存レコードの口座付け替え・集計対象外化はこの経路では実現できない（asset-manager#153 Phase 5）。


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
[ops-dashboard#85](https://github.com/guchi-apps/ops-dashboard/issues/85) で追加済み
（`requireSessionOrApiToken`）。

#### 全ソースが 401 になるとき

**トークンは同じ値を2か所で別々に管理している。** ここがずれると6ソースすべてが 401 になる（#63）。

| どちら側 | 環境変数 | 1Password |
|---|---|---|
| ops-dashboard（受け） | `OPS_API_TOKEN` | `op://apps/ops-dashboard/ops-api-token` |
| AIDE（送り） | `AIDE_OPS_DASHBOARD_TOKEN` | `op://apps/aide/ops-dashboard-token` |

`unavailable` が **1本だけ** 401 なら ops-dashboard 側のルート追加漏れ、**6本すべて** 401 なら
値の不一致か、ops-dashboard 側で `OPS_API_TOKEN` が未設定（未設定だとトークン経路は常に不可）。
`configured: true` なのに全滅している場合は、AIDE側の設定漏れではなく**値のずれ**を疑う。

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


## コネクタ: subscription-lists

月額固定費（サブスクリプション）と次の支払予定。**AIDEは契約情報を持たない。**
[subscription-lists](https://github.com/guchi-apps/subscription-lists) が既に管理しているため、
サーバー間参照用の読み取りAPI（`GET /api/internal/subscriptions`）を叩いて `aide_money_summary` の
`fixedCosts` に畳むだけにしている。ops-dashboard と同じ「既にある集約を横断ビューへ畳む」ケース。

```
src/core/connectors/subscriptions/
  types.ts   subscription-lists のレスポンスのうち、AIDEが使うフィールドだけを再宣言
  index.ts   1本のGET。設定・タイムアウト・失敗理由の丸め
src/core/views/money.ts      Zaimのキャッシュと合わせて畳む（summarizeFixedCosts は純粋関数。テストはここ）
```

### 経路

両方とも同じVPS上で動くため **localhost で届き、subscription-lists を外部公開する必要がない**。
`fetch` しか使わないので実行時依存も増えない。

| 環境変数 | 未設定のとき | 設定したとき |
|---|---|---|
| `AIDE_SUBSCRIPTIONS_URL` | `http://127.0.0.1:3107` | そのURLへ問い合わせる |
| `AIDE_SUBSCRIPTIONS_TOKEN` | 取得を試みず「未設定」を返す | `Authorization: Bearer` で認証する |

トークンは相手側の `INTERNAL_API_KEY` と**同じ値**で、**認証情報として扱う**（片方だけ変えると連携が
止まる）。取得に失敗しても Zaim 由来の残高・保有銘柄は従来どおり返す。失敗の理由はHTTPステータスと
例外の種別まで丸める（例外の `message` にはURLが載るため）。

### 計算はしない

月額換算・次回支払日・契約状況は**相手が計算済みで返す**。月末クランプ（`billingDay=31` の2月）・
料金改定履歴の期間切り替え・請求サイクルの判定は向こうの `src/lib/billing.ts` にあり、こちらで
再実装すれば必ずズレる。仕様は subscription-lists の
[`docs/internal-api.md`](https://github.com/guchi-apps/subscription-lists/blob/develop/docs/internal-api.md)。

**基準日（`referenceDate`）は日本時間で渡す。** VPSのタイムゾーンはUTCで、渡さないと日本時間の
00:00〜09:00 が前日基準で計算される。

### 返す粒度と、totals へ足さない理由

通貨別の月額合計・契約ごとの明細・**31日以内の支払予定**まで。契約IDや支払方法・ラベルは返さない
（詳細は subscription-lists の画面がある）。

`MoneySummary.totals`（残高・保有銘柄）へは**足さない**。あちらは「いま持っている額」（ストック）で
固定費は「毎月出ていく額」（フロー）にあたり、同じ合計に混ぜると意味が壊れる。

通貨は `JPY` / `USD` の混在を許すため、**合計は通貨別**で返す。円換算値（`monthlyJpy`）は相手が
Frankfurter のレートで計算した参考値で、取得できていなければ `null` になる。


## コネクタ: myroom

いまの部屋の状態（室温・湿度・気圧・CO2・照度とエアコンの運転状態）。**AIDEはセンサーの値を
集めない。** [myroom](https://github.com/guchi-apps/myroom) が Raspberry Pi からの受信・保存・
鮮度判定まで持っているため、サーバー間参照用の読み取りAPI（`GET /api/internal/room-state`）を
叩いて `aide_room_status` に畳むだけにしている。ops-dashboard・subscription-lists と同じ
「既にある集約を横断ビューへ畳む」ケース。

```
src/core/connectors/myroom/
  types.ts   myroom のレスポンスのうち、AIDEが使うフィールドだけを再宣言
  index.ts   1本のGET。設定・タイムアウト・失敗理由の丸め
src/core/views/room.ts       しきい値判定と圧縮（summarizeRoom は純粋関数。テストはここ）
```

### 経路

両方とも同じVPS上で動くため **localhost で届き、myroom を外部公開する必要がない**。
`fetch` しか使わないので実行時依存も増えない。

| 環境変数 | 未設定のとき | 設定したとき |
|---|---|---|
| `AIDE_MYROOM_URL` | `http://127.0.0.1:8000` | そのURLへ問い合わせる |
| `AIDE_MYROOM_TOKEN` | 取得を試みず「未設定」を返す | `Authorization: Bearer` で認証する |

トークンは相手側の内部APIキーと**同じ値**で、**認証情報として扱う**（片方だけ変えると連携が
止まる）。失敗の理由はHTTPステータスと例外の種別まで丸める（例外の `message` にはURLが載るため）。

**myroom の読み取りAPIは元々 Supabase のユーザーログイン必須**で、サーバー間から読める口が無い。
内部APIは [myroom#161](https://github.com/guchi-apps/myroom/issues/161) で追加する。**未実装の
バージョンに対しては 404 が返り、`unavailable` に「内部APIが未実装のバージョン」として出る。**

### 鮮度と判定

**センサーの鮮度判定・気圧オフセットの適用・デバイスの表示名は myroom 側が持っている。**
こちらで再実装すれば必ずズレるため、判定済みの値を受け取る（しきい値は `staleThresholdMinutes`
として一緒に返る）。

**受信が止まっているセンサー（`stale`）の値は判定に使わない。** 数日前に止まったセンサーの32℃を
「いまの室温」として報告してしまうため（ops ビューがオフラインのホストを評価しないのと同じ）。
値そのものは残すので、後から見れば何度で止まったかは分かる。

快適域のしきい値は `src/core/views/room.ts` の `THRESHOLDS` にまとめてある（CO2の1000ppmは
建築物衛生法の管理基準）。

### 返す粒度

「いま部屋がどうなっているか」に答えられるところまで。**履歴・日別統計・記録の一覧は返さない。**
生の時系列を渡してもコンテキストを食うだけで答えは良くならない（詳細は myroom の画面がある）。

**キャッシュを挟まない。** 部屋の状態は鮮度そのものが価値であり、ジョブ間隔ぶん古くなると
「いま暑いか」に答えられなくなる（README「どこまでを『重い取得』とみなすか」の右側）。


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
AIDEが持つのは**横断ビュー**と、下記のIssue起票だけに限る。

### 書き込みはIssueの起票1本だけ

外出先でClaudeアプリに思いついたことを話し、そのままIssueにしたいという要望
（guchi-apps/question#15）に対して `aide_create_issue` を持つ（aide#50）。

**Claudeアプリからの経路だけが塞がっていた**ため入れたもの。Claude Code（端末・GitHub Actions）は
`gh issue create` で起票できるが、issue-deck はMCPサーバーを持たず `POST /api/issues` は
Cookie認証のため、Claudeアプリから叩けるものが1つも無かった。「責務」の3条件を満たす。

- **作成だけ。** 編集・close・コメント・PR操作は持たない。issue-deck の画面と Claude Code の仕事
- **トークンを分ける。** 取得用の `AIDE_GITHUB_TOKEN` はRead-onlyのままで、起票は
  `AIDE_GITHUB_ISSUE_TOKEN`（Issues: Read and write）を使う。フォールバックはしない
- **AIDEが起票してもissue-deckと食い違わない。** issue-deck は webhook で GitHub 側の Issue を
  取り込むため、どちらから作っても同じように画面へ出る
- **暴発を機械的に止める。** Claudeは会話の流れでツールを自発的に呼ぶため、1回の呼び出しで1件・
  10分あたり3件・直前と同一タイトルは拒否、という上限をコード側に持つ（`write.ts`）
- **ラベルを勝手に作らない。** GitHubのIssue作成APIは未知のラベル名を渡すとラベルごと新規作成
  してしまう。起票前に対象リポジトリのラベル一覧を引き、実在するものだけを付ける
  （既定は `70.confirm`。無いリポジトリでは黙って落ちる）
- **出所を本文に残す。** 口述の書き起こしは人が自分で書いたIssueと精度が違うため、本文末尾に
  AIDE経由で起票した旨と `<!-- aide:created-via-mcp -->` を必ず付ける

### 返す粒度

**状態の俯瞰まで。ソースコードやREADMEの本文は返さない**（aide#32 で確定）。ファイル取得の
ツールは追加しない。返す量が大きくなるうえ「MCP層は狭く」の方針とぶつかる。コードの詳細は
Claude Code（CLI）とissue-deckが担当する。

取得のツールは**1本だけ**（`aide_dev_status`）。「全体の俯瞰」と「1リポジトリの詳細」を別ツールに
割るとツール選択が曖昧になるため、引数 `repo` の有無で深さを切り替えている
（起票の `aide_create_issue` は用途が別なので分けている。上記「書き込みはIssueの起票1本だけ」）。

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
| `AIDE_GITHUB_ISSUE_TOKEN` | `aide_create_issue` が「未設定」を返す。GitHubへは何も送らない |
| `AIDE_GITHUB_ORG` | `guchi-apps` |
| `AIDE_GITHUB_REPOS` | archived を除き、直近 `AIDE_GITHUB_ACTIVE_DAYS` 日にpushがあったものを自動で拾う |
| `AIDE_GITHUB_ACTIVE_DAYS` | `90` |

トークンは**認証情報として扱う**。ログにもMCPのレスポンスにも出さない。取得失敗の理由は
HTTPステータスと例外の種別まで丸める。GraphQLの `errors` も `message` は載せず、
どのリポジトリのどのフィールドかと種別だけを返す（`message` に内部の構成が載ることがあるため）。

fine-grained PAT を使う。GitHub App は採らなかった（この用途に対して、秘密鍵の保管と
JWT署名→インストールトークン交換の実装が重い）。**取得用と起票用で別のトークンを持つ。**

| トークン | 権限 | 使うところ |
|---|---|---|
| `AIDE_GITHUB_TOKEN` | Metadata / Contents / Issues / Pull requests / Actions の **read のみ** | `aide_dev_status` |
| `AIDE_GITHUB_ISSUE_TOKEN` | Metadata: read と **Issues: read and write** のみ | `aide_create_issue` |

1本にまとめて取得側にも書き込み権限を持たせると、26リポジトリを横断する取得の経路が
そのまま書き込みのできる経路になる。分ければ、起票を止めたいときにこのトークンだけ失効させればよい。
`readGitHubWriteConfig()` は `AIDE_GITHUB_TOKEN` へフォールバックしない（Read-onlyのトークンで
書き込みを試みて403を返すだけの経路ができ、権限を持たせたかが設定から読み取れなくなるため）。

キャッシュは挟まず**都度叩く**。1リクエストで済み、レート制限にも余裕があり、
「いまどうなっているか」という問いに対してキャッシュの古さは害にしかならない。

## コネクタ: Open-Meteo（天気予報）

朝のブリーフィング（guchi-apps/question#7）の材料として、今日・明日の天気・最高／最低気温・
降水確率を取得する。

```
src/core/connectors/weather/
  types.ts   応答のうちAIDEが使うフィールドと、正規化後の形（WeatherForecast）
  parse.ts   日ごとの配列を1日ずつへ畳む＋WMO天気コードの日本語化（純粋関数。テストはここ）
  index.ts   地点の設定・問い合わせURL・失敗理由の丸め
src/worker/jobs/weather-sync.ts   毎時取得してキャッシュ（weather-forecast）へ書く
```

### Open-Meteo を直接叩く

myroom（`backend/weather.py`）と portfolio（`src/hooks/use-weather.ts`）が既に Open-Meteo を
使っており、取得元が揃う。**APIキーが要らない**ので新しい認証経路が増えず、`fetch` だけで
書けるので実行時依存も増えない。

**myroom 経由にはしない。** ops-dashboard・subscription-lists をあの形にしたのは「認証情報を
1か所へ閉じる」「スケジューラを集約する」ためで、天気はAPIキーも巡回も持たないためどちらにも
当たらない。挟むと結合が増えるだけになる。

### 利用条件（無料枠）

| 条件 | AIDEでの扱い |
|---|---|
| 非商用に限る | 個人利用なので満たす |
| 1日10,000回未満（1時間5,000回・1分600回） | 毎時1回の worker ジョブだけが叩く（1日24回） |
| CC BY 4.0 の帰属表示 | `WeatherForecast.attribution` に同梱し、**機能一覧ページ（`/features`）に出す** |

帰属表示を `/features` に置いたのは、天気そのものはキャッシュと横断ビュー（＝認証の内側）に
しか出ないため。誰でも見られるページに1か所だけ持たせ、取得元が増えたらそこへ足す。

### キャッシュを挟む理由

取得自体は軽い（HTTP GETが1本）ので「どこまでを重い取得とみなすか」では都度叩く側にあたるが、
**利用回数の条件がある外部API**なので、呼ばれた回数だけ外へ出ていく作りにはしない。
予報は毎時更新なので、毎時取れば鮮度も足りる。

### 設定

| 環境変数 | 未設定のとき |
|---|---|
| `AIDE_WEATHER_LAT` | `34.82`（myroom の `OUTDOOR_LAT` と同じ） |
| `AIDE_WEATHER_LON` | `135.56`（myroom の `OUTDOOR_LON` と同じ） |

**値が要るのは worker が動くサブPCだけ**（VPSはキャッシュを読むだけ）。座標として読めない値は
既定へ落とさず例外にする。黙って既定へ戻すと、書き間違えたまま「別の地点の予報が正常に
取れている」状態になり、画面にも通知にも異常が出ない。

座標は自宅の位置にあたるため、**ログにも失敗通知にも出さない**。失敗理由はHTTPステータスと
種別まで丸める（`Open-Meteo が HTTP 429 を返しました（利用回数の上限）` など）。


## 横断ビュー: 朝のブリーフィング

Claudeアプリから「今日はどんな感じ？」と聞いたときに、**今日の予定・交通・天気**を1回の呼び出しで
返す（guchi-apps/question#7・aide#36）。3ソースをClaudeに個別に叩かせると往復もトークンも増えるため、
AIDE側で1本に畳む。

```
src/core/views/briefing.ts   セクションの器・天気の畳み込み・未接続の表現（純粋関数。テストはここ）
src/mcp/tools/briefing.ts    aide_daily_briefing
```

**MCPツールはこの1本だけ。** `aide_weather`・`aide_transit_delay` のような単機能ツールは作らない。
各コネクタは Core に置き、MCP層へ出す口はこのビューへ集約する（「Core は広く、MCP層は狭く」）。

### ソースごとに独立して失敗させる

「予定は取れたが交通が取れなかった」を表現できるように、セクションごとに `state` を持たせ、
**1つの失敗で全体を落とさない**。`state` は4つ。

| 値 | 意味 |
|---|---|
| `ok` | 中身が入っている |
| `unavailable` | 接続は設定されているが取得できなかった（対象日ぶんが無い場合も含む） |
| `not_configured` | 接続が設定されていない（トークン等が未設定） |
| `not_connected` | コネクタ自体がまだ無い。依存Issueの完了待ち |

`unavailable` と `not_connected` を分けているのは、**前者は直せば取れる／後者はまだ存在しない**という
違いをClaudeに伝えるため。どちらも「情報が無い」だが、言うべきことが違う。

### 「今日」はJSTの暦日で切る

`Asia/Tokyo` の暦日（`YYYY-MM-DD`）を対象日とし、深夜も暦日どおりに扱う。ツールは引数を取らない。

**天気は日付で突き合わせる。配列の先頭を「今日」とみなさない。** キャッシュは日付をまたいで残るため、
添字で取ると日付が変わった直後に昨日の予報を「今日」として返してしまう。対象日が含まれていない場合は
`unavailable` にして、取得済みの時刻と理由を添える。

#### 深夜0時台は「明日」が必ず欠ける

天気の取得は今日・明日の2日ぶん固定（`FORECAST_DAYS`）で、同期は毎時。**日付が変わってから次の同期が
走るまでは、キャッシュの中身が「前日・当日」のまま**になり、`tomorrow` が見つからない。このとき
キャッシュ自体は新しいので `stale` にはならない（180分に満たない）。

セクション全体は落とさず `tomorrow` だけを `null` にし、**「明日の天気が無い」と読まれないよう `note` に
断り書きを添える**。日をまたいだ直後だけ毎日起きる状態なので、鮮度の判定で表現しようとすると壊れる。

### `aide_room_status` との棲み分け

`aide_daily_briefing` が返す天気は**今日・明日の予報**、`aide_room_status` が返すのは**いまの実測**
（室温・湿度・CO2と、myroom 経由の屋外の気温・湿度・気圧）。「いま暑いか」は後者、「今日は暑くなるか」
「傘は要るか」は前者にあたる。**両方のツールの説明文でこの違いを書き分ける**——横断ビュー同士でも、
選択が曖昧になればMCP層を狭くしている意味が無くなる。

### 鮮度はビュー全体で揃えない

天気は毎時更新のキャッシュ、交通は分単位、予定は都度と性質が違うため、1つの `stale` に潰すと意味が
壊れる。`fetchedAt` / `ageMinutes` / `stale` は**セクションごとに持つ**。

### 揃った順に足す

現時点で実データを返せるのは天気だけで、予定（DaySpan側のGET API: guchi-apps/dayspan#236 ＋ AIDE側の
コネクタ）と交通（aide#33）は `not_connected` を返す。セクションは名前付きフィールドと共通の器
（`BriefingSection<T>`）にしてあるので、コネクタが入ったら該当セクションを差し替えるだけで足せる。
ニュース（question#7 で保留中）を後から加える場所も同じ。

**MCPの同期リクエスト内で重い取得は行わない。** 天気はキャッシュを読むだけ。交通・予定を足すときも
localhost への軽いHTTP GETに、短いタイムアウトを必ず掛ける（「どこまでを『重い取得』とみなすか」）。

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
npm run worker zaim-refresh     # 連携口座を一括更新（押して完了を待つ、日次想定）
npm run worker zaim-sync        # 巡回してキャッシュ更新（重い、日次想定）
npm run worker zaim-keep-alive  # セッション延長のみ（軽い、30分ごと想定）
npm run worker weather-sync     # 天気予報を取得（軽い、1時間ごと想定）
```

常駐させずワンショットで実行し、スケジューリングは外（cron / systemd timer / PM2）に任せる。常駐プロセスを増やさずに済み、失敗しても次回実行で自然に復旧する。失敗時は終了コード1を返すので、スケジューラ側から検知できる。

### 実行記録

実行のたびに結果を `job-<ジョブ名>` というキャッシュキーへ1件だけ書く（`src/worker/record.ts`）。
動作状況ページ（`/status`）はこれを読んで「最後に成功したのはいつか」に答える。

**通知（Signaly）では代われない。** あちらは流れて消えるうえ、成功時は何も送らないため、
「動いているが最後の成功が3日前」という状態を後から知る手段が無かった。

置き場をキャッシュにしているのは、**worker がサブPC・サーバーがVPS**で動くため。ファイルに書いても
サーバーからは見えないが、取得結果と同じ経路（`POST /api/cache/:key`）に載せれば、開発機（両方ローカル）と
本番（別マシン）で同じコードのまま届く。ジョブごとにキーを分けているのは、1つにまとめると書く前に
現在値を読む必要があり、書き込み専用の受け口に読み取り口を足すことになるため。

記録するのは成否・時刻・所要時間・1行のメッセージ・実行ホストだけで、取得した値そのものは入れない。
記録に失敗してもジョブは失敗させない（通知と同じ方針）。

### 実行間隔の制約

Zaimの認証Cookieは**約2時間**で失効し、アクセスのたびにその時点から延長される。したがって **2時間以内に必ず1回はZaimへアクセスする必要がある**。

| ジョブ | 間隔 | 最悪間隔 | 理由 |
|---|---|---|---|
| `zaim-keep-alive` | 30分ごと（揺らぎ2分） | 32分 | 有効期間2時間に対し、**3回続けて失敗しても間に合う**余裕を取る |
| `zaim-refresh` | 日次 23:15 JST | — | 押してから反映まで5〜15分かかる。24時までにその日の最終データを確定させるための逆算 |
| `zaim-sync` | 日次 23:35 JST | — | 資産評価額は日次で足りる。`zaim-refresh` の完了を見込んだ時刻に置き、**その日のうちに**当日の値を確定させる |

「最悪間隔」は `RandomizedDelaySec` を含めた実際の空き時間。**`zaim-keep-alive` はここを2時間より十分短く保つことが要件**で、毎時（最悪1時間5分）では1回失敗しただけで超えていた（#63）。日次の2つは巡回そのものが目的なので、この制約は掛からない。

**`zaim-sync` は以前05:00 JSTだった。** 「issue-deckの並行ビルドと競合せず、朝の時点で当日のデータが揃う」ことが理由だったが、その時刻では更新ボタンを押した当日ぶんが翌日のキャッシュにしか載らない。23:35へ移しても朝には前夜23:35のデータ（経過8時間ほど）があり、当日ぶんが揃っているという条件は満たせるため移した（#62）。

subpcのシステムTZはUTCなので、タイマーには `Asia/Tokyo` の明示が必須。

**このスケジューリングは常時起動のホストに置く必要がある。** 開発機（メインPC）は常時起動しない前提のため、セッションを維持できない。本番では subpc が担う。

### systemdユニット

ユニットは `deploy/systemd/` にある。**実行場所はサブPCの `~/.config/systemd/user/`** で、リポジトリからは自動反映されない（VPSへの `deploy.yml` が触るのはサーバー側だけ）。間隔を変えたら手で反映する。

```bash
cp deploy/systemd/*.timer deploy/systemd/*.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now aide-zaim-refresh.timer   # 初回のみ（未導入のユニット）
systemctl --user restart aide-zaim-keep-alive.timer aide-zaim-refresh.timer aide-zaim-sync.timer
systemctl --user list-timers 'aide-*'
```

以前はユニットがリポジトリの外にしか無く、間隔がなぜその値なのかを追えなかったため、実体をこちらへ移している。

**サブPC側のコードも自動では更新されない。** `deploy.yml` が配るのはVPS（サーバー）だけで、
worker が動く `~/apps/aide` は**人が `git pull` するまで古いまま**。worker まわりの修正は、
`develop` へマージしただけでは効かない（#89 の時点で17コミットぶん遅れていた）。

```bash
# サブPCで
cd ~/apps/aide && git pull --ff-only
```

### ジョブ失敗の通知

終了コード1は systemd のジャーナルに残るだけで誰にも届かない。実際に `aide-zaim-sync.service` の失敗が丸一日気づかれずに放置されたため、失敗を [Signaly](https://github.com/guchi-apps/signaly)（Webhook受信 + Web Push の通知ハブ）へ送っている（`src/worker/notify.ts`）。

| 環境変数 | 未設定のとき | 設定したとき |
|---|---|---|
| `AIDE_SIGNALY_WEBHOOK_URL` | 通知しない（開発機） | 失敗・復旧をそのWebhookへ送る（本番 = サブPC） |

URLに含まれる `channel_id` が宛先の識別子そのもの（Webhook自体は認証なし）なので、**認証情報として扱う**。ログにも通知本文にも出さない。

送るのは次の2つだけ。

- **失敗**: ジョブ名・失敗理由・発生時刻・実行ホストを載せる。`ZAIM_SESSION_EXPIRED` の場合は手動ログインをやり直すまで直らないため、タイトルと「対応」欄で他の失敗と区別できるようにしている
- **復旧**: 失敗が記録されている状態で成功したときに1回だけ
- **一部失敗**: `zaim-refresh` で更新できなかった口座があるとき。**ジョブ自体は成功扱いのまま**（押下は成功しており、AIDE側では直せない）。署名は「更新できなかった口座名の集合」なので、同じ口座が落ち続けている間は静かになり、別の口座が落ちたときは抑制せずに届く。記録は `<ジョブ名>:stale-accounts` としてジョブ自体の失敗とは別に持つ

日次の成功は送らない。`zaim-keep-alive` は30分ごとなので、成功も送ると1日48件になり肝心の失敗が埋もれる。

**同じ理由で失敗し続けている間は6時間に1回まで**に抑えている（30分ごとの `zaim-keep-alive` がセッション失効すると、抑制しないと48件/日届く）。理由が変わった場合は抑制せずに送る。抑制で黙っている状態と直った状態を区別できるように、復旧通知だけは出している。

未解決の失敗は `data/worker/notify-state.json` に持つ（ジョブ名・失敗理由の署名・時刻・回数だけ。取得データも認証情報も入れない）。**通知の送信失敗でジョブを二重に失敗させない。** 送信・記録まわりの例外はすべて握りつぶし、ログに一行残すだけにする。送れなかった回は通知済みにせず、次の実行で送り直す。

**プロセスが起動する前に落ちるケース（node が起動しない・OOMで強制終了）は拾えない。** そこまで拾うなら systemd の `OnFailure=` が要る（ユニットは `deploy/systemd/` にある）。

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

**両方とも未設定の場合は失敗しない。** 開発機ではそれが正しい挙動だが、**サブPCで設定を落とすとジョブは成功したままVPSのキャッシュだけが止まる。** 実際、サブPCの `.env` にこの2つが無く、巡回結果がサブPC側の `data/cache/` にだけ書かれ続け、本番のキャッシュが3日ぶん古いままになっていた（#89）。サーバー側からは worker の `.env` を見られない（[worker 側の設定は「未設定」と断定しない](#worker-側の設定は未設定と断定しない)）ため、**サブPC側で確かめる。**

```bash
# サブPCで。値そのものは出さず、設定されているかだけを見る。
grep -c '^AIDE_INGEST_\(URL\|SECRET\)=' ~/apps/aide/.env   # 2 なら設定済み
journalctl --user -u aide-zaim-sync.service -n 5 -o cat      # 「…へ送信した」なら届いている
```

ジョブのログが「ローカルのキャッシュへ書いた」で終わっている間は、**何度巡回しても本番のキャッシュは更新されない。**

### 受け口の認証

MCPのOAuthとは別系統で、共有シークレット1本。呼び出し元が自分のworkerに限られるためOAuthは過剰で、issue-deck の dispatch と同じ方式に揃えている。

受け入れるキーはサーバー側で明示的に限定している（任意のキーで書き込めると、参照側が読まないゴミが溜まる）。**巡回結果（`zaim-snapshot`）だけでなく、ジョブの実行記録（`job-<ジョブ名>`）も同じ経路で届く**ので、両方を許可する。記録側は送信に失敗しても例外を投げない（ジョブを二重に失敗させないため）ので、ここで弾くとログ1行が残るだけで、`/status` のジョブ欄が永久に「記録なし」になる（#89）。


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
  "balances": [{ "name": "〇〇銀行", "amount": 1000000,
                 "lastUpdatedAt": "2026-08-16T23:20:11+09:00" }],
  "holdings": [{ "account": "〇〇証券", "name": "〇〇インデックス", "amount": 234567,
                 "occurrence": 1, "occurrenceCount": 1,
                 "lastUpdatedAt": "2026-08-16T23:21:00+09:00" }],
  "onlineAccounts": [{ "name": "〇〇銀行", "lastUpdatedAt": "2026-08-16T23:20:11+09:00" }],
  "staleAccounts": [{ "name": "△△銀行", "lastUpdatedAt": "2024-12-18T10:00:00+09:00" }],
  "note": "..."
}
```

**取得時刻と経過分数を必ず併せて返し、鮮度の判断は呼び出し側に委ねる。** MCP層と同じ方針で、AIDEは
「古いから返さない」という判断をしない。キャッシュが空でも200を返す（`empty: true`）。まだ一度も巡回して
いないのは状態であってエラーではなく、呼び出し側が区別できる形で伝わればよい。

`lastUpdatedAt` は **Zaim側が各金融機関から取得した時刻**で、AIDEが巡回した時刻（`fetchedAt`）とは別物。
更新できない口座があると巡回が新しくても中身は古いままになるため、当日でないものを `staleAccounts` に
まとめている（[更新できない口座の扱い](#更新できない口座の扱い)）。**これも捨てるかどうかは決めない。**
連携していない口座（現金・手入力）と、この項目を持たない時期のキャッシュでは `null` になる。

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
外向けURLへ送るためで、Apacheで絞るなら `/api/money` と `/api/zaim` を対象にする。


## 個人アプリ向けのZaim登録API

car-care（給油記録）・asset-manager（レシート由来の支出）がZaimへ支出を登録するための口。実装は `src/api/zaim.ts`。

| | |
|---|---|
| エンドポイント | `POST /api/zaim/payment` / `GET /api/zaim/master` |
| 認証 | `Authorization: Bearer $AIDE_ZAIM_WRITE_SECRET` |
| 必要な設定 | 上のシークレットと、Zaim OAuthの4つ（`AIDE_ZAIM_CONSUMER_KEY` ほか）。**1つでも欠ければ503** |

```bash
curl -s -X POST -H "Authorization: Bearer $AIDE_ZAIM_WRITE_SECRET" \
  -H "Content-Type: application/json" http://127.0.0.1:3114/api/zaim/payment \
  -d '{"requestId":"car-care:fuel-log:1234","amount":6800,"date":"2026-08-19",
       "categoryId":101,"genreId":10101,"fromAccountId":12345,"place":"〇〇SS"}'
# => {"ok":true,"moneyId":987654321,"duplicated":false,"requestId":"car-care:fuel-log:1234"}
```

### 呼び出しの向きは「アプリ → AIDE」

読み取り（`GET /api/money/summary`）はアプリがAIDEから引くが、登録も**アプリからのpush**にしている。
登録済みかどうかの状態（Zaimの `money_id`）を持つのは各アプリのレコードで、登録の起点も画面操作だから。
AIDEがアプリを巡回して「未登録の支出」を集める形にすると、アプリごとに取得APIを生やすことになる。

### カテゴリ・ジャンルはAIDEが決めない

`categoryId` / `genreId` / `fromAccountId` は**呼び出し元がIDで指定する**。「ガソリン代 → 自動車費/ガソリン」
のような対応はアプリ側のドメイン知識で、AIDEに持ち込むとアプリが増えるたびにここが太る。
IDは `GET /api/zaim/master`（口座・カテゴリ・ジャンルの一覧）で引ける。連携先の設定時に一度引いて、
アプリ側の設定として持つ想定。

### 二重登録を止める

**同じ支出をZaimへ2回登録しても、この経路からは取り消せない**（作成だけを持ち、削除は持たない）。
呼び出し元が自分のレコードごとに一意な `requestId` を付け、AIDE側は
`data/zaim-payments.json` に `requestId` → `money_id` を記録する（直近500件）。

- **Zaimへ送る前に記録する。** 送った後に記録すると、応答が届かなかった場合に何も残らず、再送で二重登録になる
- 登録済みの `requestId` はZaimへ送らず、前回の `money_id` を `duplicated: true` で返す
- **前回の結果が確定していない `requestId` は 409 で止める。** 打ち切り・Zaim側の障害では登録された
  可能性が残るため、機械的な再送を許さない（人がZaimを確認し、未登録なら別の `requestId` で送り直す）
- Zaimが内容を拒んだ（4xx）ときだけ記録を消し、直してからの再送を許す

記録に書くのは `requestId`・`money_id`・時刻の3つだけで、**金額・店名・コメントは持たない**。
二重登録を防ぐのに要らないうえ、支出の中身そのものを持つのは取得・整形という責務から外れる。

### 応答の意味

| 状態 | 意味 |
|---|---|
| 200 | 登録できた（`duplicated: true` なら再送で、Zaimへは送っていない） |
| 400 | 入力が不正。直して送り直す |
| 409 | 前回の結果が不明。**再送しない**。Zaimを確認する |
| 422 | Zaimが内容を拒んだ。登録はされていない |
| 502 | Zaimへ届かない・打ち切り。登録されたかは不明 |
| 503 | `AIDE_ZAIM_*` が揃っておらず、口が開いていない |

### 公開範囲と、遮断が入るまでの守り

呼び出し元は同じVPS上のアプリなので `http://127.0.0.1:3114` で叩く。ただし上記のとおり
**`/api` を丸ごと外部から遮断できない**ため、この2本も公開URL上に出ている。晒されるのは
「書き込む口」だけでなく、`GET /api/zaim/master` が返す**口座名の一覧**も含む。

- Apacheで `/api/zaim` を外部から落とす（vps側の設定。aide#103 の手作業に含めている）
- 遮断が入るまでのあいだ、盾は `AIDE_ZAIM_WRITE_SECRET` 1本になるため、**認可画面と同じ
  総当たり対策**（送信元ごとに15分あたり5回まで・失敗時に固定の待ち・超過で429）を掛けている
  （`src/api/zaim.ts`）。回数の枠は画面のログインとは別に数える
- シークレットは `openssl rand -base64 32` 相当の長さにする（推測ではなく総当たりの対象になるため）

### アクセストークンの取得

consumer key / secret は [dev.zaim.net](https://dev.zaim.net/) でのアプリ登録で発行する。
アクセストークンはブラウザでの認可が要るため、実行時ではなく次のスクリプトで1回だけ取る。

```bash
AIDE_ZAIM_CONSUMER_KEY=xxx AIDE_ZAIM_CONSUMER_SECRET=yyy \
  node src/core/connectors/zaim/scripts/oauth-token.mjs
```

認可の画面は手元のPCのブラウザで開き、戻り先URLに付く `oauth_verifier` を貼り付ける。
取れた値は本番の `.env`（GitHubのsecret経由）と1Passwordにだけ置く。


## 認証

ClaudeアプリからリモートMCPサーバーへ接続するための OAuth 2.1 を実装している。認可サーバーとリソースサーバーを同一プロセスに置いている（利用者が1人で、分ける利点がないため）。

**ここで扱うのは「機械（Claudeアプリ）をこのサーバーへ接続させる」ための認可で、利用者の身元は問わない。** ブラウザで動作状況ページ（`/status`）を開くほうは別系統で、許可したGoogleアカウントだけが通る（[動作状況ページ](#動作状況ページ) を参照）。

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

動作状況ページのGoogleログインには回数制限を置いていない。総当たりできるパスワードが無く、
許可リストに載っているかどうかはGoogleでのログインを終えて初めて判定されるため。

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

### 環境変数の配線

**本番の `.env` は `deploy.yml` が毎回まるごと上書きする。** VPS上で手で追記した値はデプロイのたびに
消える。消えても例外にはならず、そのコネクタが「未設定」を返すだけなので、次に呼ぶまで誰も気づけない
（実際に `AIDE_GITHUB_TOKEN` と `AIDE_OPS_DASHBOARD_TOKEN` がその状態だった。#55）。

実行時に本番で要る値を足すときは、**5か所すべて**に通す。

| # | 場所 | 役割 |
|---|---|---|
| 1 | `.github/secrets-manifest.tsv` | 1Password（正）と GitHub secret/variable の対応表 |
| 2 | `deploy.yml` のジョブの `env:` | GitHub側の値を取り出す。`scripts/generate-workflow-env-block.sh` で生成する |
| 3 | 「Deploy and restart」ステップの `env:` | SSHアクションへ渡す |
| 4 | 同ステップの `envs:` | **appleboy/ssh-action はここに列挙した名前しかリモートへ渡さない** |
| 5 | 同ステップの `.env` heredoc | 実際にVPSへ書き出す |

1Password 側へ値を入れたら `scripts/sync-github-secrets.sh --only <KEY>` で GitHub Secret へ同期する
（実行時に1Passwordは呼ばない。#1）。トークン類は未発行でもデプロイを止めないよう `${VAR:-}` で書き、
空ならAIDE側が「未設定」として振る舞う。

この5か所の抜けは `src/deploy-env-wiring.test.ts` が検査する。`src/` が読む `AIDE_*` は、すべて
配線されているか、テスト内の `NOT_REQUIRED_IN_PRODUCTION` に理由付きで登録されているかのどちらかになる。
