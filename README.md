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

## 構成

```
src/
  server.ts            エントリポイント。/mcp と /api を1プロセスで提供
  mcp/
    transport.ts       Streamable HTTP transport
    registry.ts        ツール登録簿
    tools/             MCPツール
  core/
    connectors/        外部サービスからの取得
    models/            共通データモデル
    views/             横断ビュー
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

### 金額の扱い

`balances`（残高一覧）には証券口座の**合計**が含まれ、`holdings`（保有銘柄）はその**内訳**にあたる。両者を足すと証券分を二重に数えるため、横断ビューでは合算値を出していない。


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
