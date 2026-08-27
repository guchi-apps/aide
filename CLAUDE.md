# aide — エージェント向けガイド

生活情報まわりの共通バックエンド／ハブ。責務・レイヤー分け（Core と MCP層の境界）・設計の背景は
[README.md](./README.md) を参照する。**設計判断の正本は Notion 側**で、READMEはコードを読むうえで
必要な範囲だけを持つ。ここにはエージェント（Claude Code）が守る運用ルールと、READMEに書かれていない
判断基準だけを書く。

**GitHub Actions 上での無人実行は、このリポジトリをチェックアウトしたワークツリーしか参照できない。**
ローカル実行ではユーザー個人環境のグローバルルール（`~/.claude/CLAUDE.md`）も読み込まれるが、
無人実行では読み込まれない。したがって無人実行でも守られる必要があるルールは、このファイルに
明文化しておく必要がある。

## 検証コマンド

**このリポジトリには `lint` も `build` も無い。** Node 24 が型ストリッピングで `.ts` を直接実行するため
ビルド工程そのものが存在せず、CI（`.github/workflows/ci.yml`）も下記の2つだけを実行している。
**存在しないコマンドを探さず、下記を使うこと。**

| 目的 | コマンド |
|---|---|
| 型チェック | `npm run typecheck` |
| テスト | `npm test`（`node --test "src/**/*.test.ts"`） |

どちらもラッパーを通さず、`.env` も要求しないため無人実行から使える。

**Node 24 以上が要る**（`package.json` の `engines` が `>=24`）。それより下では型注釈付きの `.ts` を
そのまま実行できず、`npm run dev`・`npm start` が起動しない。

**型ストリッピングは「型注釈を消すだけ」で、実行時に別のコードを生む構文は使えない。**
`tsc --noEmit` は通るのに実行時だけ `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` で落ちるため、
型チェックだけでは気づけない。該当するのは constructor 引数への修飾子（parameter property。
`constructor(readonly x: string)`）・`enum`・`namespace`・実装付き `declare` など。
フィールドは明示的に宣言する。

`dependencies` は空で、`devDependencies` は `typescript` と `@types/node` の2つだけ。**実行時依存を
増やさない方針**なので、依存を足す判断は下記「依存関係の追加」に従う。

## マルチエージェント運用（GitHub Actions 無人実行）

`@claude` コメントを起点に、計画提示〜実装〜develop向けPR作成までを GitHub Actions 上で無人実行する。
ワークフローの実体は `guchi-apps/issue-deck` にあり、このリポジトリの `.github/workflows/` には
`uses:` で参照する薄い caller だけを置いている（`@workflows/v27`）。

develop向けPRが `develop` とコンフリクトした場合は、`claude-conflict-resolve.yml`（caller）が
無人でClaude Codeによる解消を試みる。人が `@claude コンフリクトを解消して` と依頼する必要はない。

**caller の `uses:` のタグと `prompts-ref` は必ず同じ値にする。** 参照タグを上げるときは
`.github/workflows/` 配下の caller をまとめて更新し、この節の記述も合わせて直す。

設計・運用の詳細は issue-deck 側を参照する。

- 進捗管理の設計: [progress-status-architecture.md](https://github.com/guchi-apps/issue-deck/blob/main/docs/progress-status-architecture.md)
- 無人実行の挙動: [multi-agent/dispatch.md](https://github.com/guchi-apps/issue-deck/blob/main/docs/multi-agent/dispatch.md)
- 自動修復の挙動: [multi-agent/auto-repair.md](https://github.com/guchi-apps/issue-deck/blob/main/docs/multi-agent/auto-repair.md)

### リリース・デプロイ通知

`deploy.yml` の `notify`（デプロイ）と `notify-release`（リリース）が
`.github/scripts/signaly-notify.sh` を呼ぶ。宛先は `NOTIFY_KIND` で分かれ、`リリース` のときだけ
`SIGNALY_RELEASE_WEBHOOK_URL` へ送る。未登録なら従来のCI・デプロイ用チャンネルへフォールバック
するため、secretの登録順は気にしなくてよい（guchi-apps/issue-deck#2391）。

**`NOTIFY_KIND: リリース` の行を消さない。** issue-deck の共有ファイル配布
（`propagate-shared-files.sh`）はこの行をアンカーにして通知まわりの追記を各リポジトリへ配るため、
行が無いリポジトリには以後の更新が黙って届かない。実際に aide だけリリース通知のジョブが無く、
リリースがどのチャンネルにも通知されない状態が続いていた（#184）。

### ブランチ

- 機能開発: `develop`（**デフォルトブランチ**）
- 安定版 / 本番デプロイ: `main`（マージ時に GitHub Actions が VPS へデプロイ）

Issue専用ブランチは `develop` から作成し、ブランチ名は **`issue-<Issue番号>`** とする（例: `issue-11`）。
ワークフローはブランチ名から対象Issueを特定するため、**この命名規約に従わないブランチはすべて対象外**になる。

デフォルトブランチは `develop` から変えない。`issues`・`issue_comment` イベントはデフォルトブランチの
ワークフローしか起動しないため、`main` にすると `@claude` コメントに反応しなくなる。

### Issueの進捗

**進捗は GitHub Projects の Status で管理する。進捗ラベルは存在しない**
（issue-deck#1010 / #991 Phase 5 で `01.wip`〜`09.main` を廃止した）。

1. `Ready` — 未着手
2. `Planning` — 計画検討中（`21.plan-required` 選択時のみ経由）
3. `Implementation` — 実装中
4. `Develop PR` — developへPR作成・マージ中
5. `Develop` — developへマージ完了（main未反映）
6. `Release` — mainへPR作成・マージ中
7. `Done` — mainへマージ完了。この時点でissueをcloseする

**`gh issue edit` で進捗を進めることはできない。** Status を書けるのは issue-deck だけで、
ワークフローは進捗報告API（`POST /api/progress`）へ報告する。ブランチのpush・PR作成・PRマージを
トリガーに自動で遷移するため、エージェントが自分で進捗を動かす必要はない。

### 条件を表すラベル（進捗とは別軸）

Status = 今どこにいるか、Label = どんな性質・条件があるか、という役割分担にしている。

| ラベル | 意味 |
|---|---|
| `00.check-user` | ユーザーの確認・指示が必要。どの段階でも併用する |
| `00.qa-answered` | 質問への回答のみ完了（`00.check-user` と常に併用） |
| `11.local` | ローカル（VSCode等）で対応中。付いている間は無人実行を起動しない |
| `21.plan-required` | 実装前に計画を提示し承認を得る |
| `22.merge-confirm-required` | 内容によらず、developへのマージ前に必ず `00.check-user` を付ける |
| `23.preview-required` | PR作成前に開発サーバーでの画面確認を必須にする |
| `24.screenshot-required` | PR作成前にスクリーンショット取得を必須にする |
| `71.manual-step` | エージェントが代行できないユーザー自身の手作業 |

### 自動マージ不可カテゴリ

以下に該当する変更は自動マージせず `00.check-user` を付与してユーザーの確認を待つ。

- 認証・認可（`src/auth/`）
- **外部サービスの認証情報を扱う経路**（Zaim の storage state、各コネクタの資格情報）
- 本番環境の設定（`deploy/`）
- GitHub Actionsやデプロイ設定（`.github/workflows/**`）
- Secretsや環境変数（`.env*`）
- 課金・決済
- **依存関係の追加**（依存ゼロを保つ方針そのものの変更にあたるため、更新規模によらず対象）
- `develop` → `main` のマージ

### 実装エージェントの禁止事項

- `main` / `develop` への直接コミット・push
- 他Issueのブランチの編集
- 担当Issue以外の実装（別件を新規Issueとして起票するのはよい）
- 不要なforce push
- 自分が作成したPull Requestの自己マージ
- **外部サービスへの実アクセス**（Zaim へのログイン・巡回など。storage state はCookieそのものであり、
  無人実行から触らない）

### コミット・PR・コメントの書き方

- コミットメッセージ・PRタイトル・PR本文・issueコメントは**日本語**で書く
- コミットの author は `Claude Code <claude-code@example.com>` にする
- `develop` 宛のPR本文には、対応Issue・実装内容・テスト内容・確認方法・注意点を記載する。
  developマージ時点ではissueをcloseしない運用のため、`closes #番号` / `fixes #番号` は使わず
  `#番号` のみ記載する

### 依存関係の追加

**このリポジトリは実行時依存ゼロを保っている。** 新しい依存関係を追加する前には、必ずユーザーに
確認を取る。無人実行では確認相手がいないため、追加が必要だと判断した場合は追加せずに作業を止め、
`00.check-user` を付与したうえでなぜ必要かをIssueコメントで相談する。

### シークレットの扱い

APIキー・トークン・パスワード等の実シークレットをコミットしない。コミットしてよいのは値を空にした
サンプル（`.env.example`）と、1Passwordの `op://vault/item/field` 形式の参照だけを書いたテンプレートに
限る。実値は `.gitignore` 済みの `.env*` と1Password側、およびGitHubのsecret/variableにのみ置く。

**`data/` には Zaim のログイン状態（Cookieそのもの）が入っている。** `.gitignore` 済み。
**その中身を読み書きする変更や、ログ・Issueコメントへ内容を出す変更は行わない。**
`data/` 配下にはこのほかにOAuthの状態（`data/auth/`）とMCPアクセスの記録（`data/mcp-access.json`）も
置くが、**ここへ新しいファイルを足すときは「シークレットも取得したデータ本体も書かない」ことを
確かめる**（記録に残してよい粒度の判断は README「MCPへのアクセスの記録」に例がある）。

**実行時の1Password呼び出しは行わない**（issue-deck#1307）。GitHub Actions は GitHubの
secret/variable から値を取得する。
