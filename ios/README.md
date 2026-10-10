# AIDE iOS

AIDE（`https://aide.gucchii.com/map`）を表示する iOS アプリのラッパーです。SwiftUI + `WKWebView` の Xcode プロジェクト（`AIDEios.xcodeproj`）です。

エージェント（Claude Code）向けの作業ルールは [CLAUDE.md](CLAUDE.md) にあります。このファイルは、人が Mac の Xcode で操作するときの手順をまとめたものです。

## 主な設定値

| 項目 | 値 |
| --- | --- |
| プロジェクト | `AIDEios.xcodeproj` |
| スキーム | `AIDEios`（共有スキーム。`xcshareddata/xcschemes/` にコミット済み） |
| Bundle ID | `com.gucchii.AIDEios` |
| 署名 | Automatic（Team は Xcode の Signing & Capabilities で確認） |
| Info.plist | `AIDEios-Info.plist`（`GENERATE_INFOPLIST_FILE = NO`） |
| URL スキーム | `com.gucchii.aide`（認証コールバック用） |

## 前提

- Mac に Xcode がインストール済みであること（iOS SDK を含む）
- Apple ID（Apple Developer アカウント）で Xcode にサインイン済みであること（Xcode > Settings > Accounts）
- 実機で確認する場合は、iPhone を USB／ネットワークで接続し、「デベロッパモード」を有効にしておくこと

## 初回セットアップ（Mac mini）

このディレクトリは AIDE リポジトリ（`guchi-apps/aide`）の `ios/` です（旧 `guchi-apps/aide-ios` から #525 で統合）。
Mac mini には AIDE 全体を clone します（既定の場所は `~/apps/aide`）。

```bash
mkdir -p ~/apps && cd ~/apps
git clone git@github.com:guchi-apps/aide.git
cd aide
open ios/AIDEios.xcodeproj
```

1. Xcode でプロジェクトが開いたら、左のナビゲータでプロジェクト `AIDEios` を選び、TARGETS の `AIDEios` を開く
2. **Signing & Capabilities** タブで次を確認する
   - 「Automatically manage signing」にチェックが入っている
   - Team が自分のアカウントになっている
   - Bundle Identifier が `com.gucchii.AIDEios`
3. 画面上部のデバイス選択で、接続した iPhone（またはシミュレータ）を選ぶ
4. `Cmd + R` でビルドして起動する

実機で初めて起動するときは、iPhone の「設定 > 一般 > VPNとデバイス管理」で開発元を信頼する必要があることがあります。

## iOS に関わる変更をしたときの手順

アプリは AIDE のページを `WKWebView` で開く殻なので、**入れ直しが要るのは `ios/` の配布物（`AIDEios/`・
`AIDEios.xcodeproj/`・`AIDEios-Info.plist`）が変わったときだけ**です。`src/` の変更は
何もしなくてもアプリへそのまま届きます。

- develop→main のPRには `.github/workflows/ios-rebuild-notice.yml` が「入れ直しが必要」を自動でコメントする
  （判定は `scripts/ios-changes.mjs`。README・`scripts/`・`MARKETING_VERSION` の行だけの差分は除く）
- 入れ直しは **AIDE本体が main へデプロイされた後に `main` から**行う（下記）
- ブランチ・PR・CI・リリースは AIDE 本体（ルートの `CLAUDE.md`）と同じ運用。iOS 専用のブランチやリリースPRは無い

### 入れ直し（1コマンド）

iPhone を Mac mini に USB で繋ぎ、ロックを解除してから、subpc で次を実行します。

```bash
ios/scripts/remote-install.sh
```

Tailscale 越しに Mac mini へ入り、`main` を取り込み、ログインキーチェーンを解除（パスワードはプロンプトにだけ入力）して、
Xcode でビルドして iPhone / iPad へ入れ直します。Mac mini で直接やるなら `ios/scripts/install-to-iphone.sh`。

| 環境変数（任意） | 意味 |
| --- | --- |
| `MAC_HOST` | SSH先（既定 `guchimac-mini`） |
| `MAC_REPO_DIR` | Mac mini 上のチェックアウト（既定 `~/apps/aide`） |
| `IOS_BRANCH` | 取り込むブランチ（既定 `main`） |
| `IOS_DEVICE` | 入れ先の識別子か名前（既定は接続中の1台。複数台だと止まる） |
| `IOS_SKIP_PULL=1` | git の取り込みを省く（手元の変更をそのままビルドしたいとき） |

ビルド前に `scripts/check-consistency.mjs` が走り、バージョンやログインの戻り先のずれを先に止めます。

### バージョン（`MARKETING_VERSION`）の同期

`MARKETING_VERSION` は AIDE のバージョン（ルートの `package.json`）と常に同じ値にします。
リリースのバンプPR（`release-develop-to-main.yml` の `bump-command`）が `scripts/sync-version.mjs` を呼んで
自動で揃えるので、手では書き換えません。ずれていると CI（`check-consistency.mjs`）が止めます。

### Linux（subpc）でできる確認

```bash
node ios/scripts/check-consistency.mjs   # バージョン・ログイン戻り先・pbxprojの整合
node --test ios/scripts/*.test.mjs
bash ios/scripts/check-swift-imports.sh  # 明示importの漏れ
```

どれもビルドの代わりにはなりません（CI でも毎回実行されます）。

## TestFlight への自動配布（#530）

**リリースで `ios/` の配布物が変わったときだけ、Web の本番反映のあとに TestFlight の内部テストグループへ自動で配る。**
自動では入らないので、iPhone の TestFlight アプリで更新する。Mac mini からの入れ直し（上記）は開発ビルド用に残す。

```
Deploy to Production 成功（main）
  → ios-testflight-trigger.yml（薄い起動役）
    → ios-testflight.yml: 判定 → 署名・ビルド・アップロード → ビルド処理待ち・内部グループ配布 → 印（タグ）→ Signaly通知
```

- 判定は `node ios/scripts/ios-changes.mjs`（基準は最新のタグ `ios-testflight/<ビルド番号>`。印が無ければ初回として要配布）。
  対象は `AIDEios/`・`AIDEiosTests/`・`AIDEios.xcodeproj/`・`AIDEios-Info.plist`。README・`scripts/`・版番号の行だけの差分は不要
- ビルド番号は `run_number * 100 + run_attempt`（`CURRENT_PROJECT_VERSION` は `xcodebuild` の引数で上書き）。表示バージョンは `package.json` と同期済みの `MARKETING_VERSION`
- 署名は App Store Connect API キーによるクラウド署名。**アーカイブは署名せず（`CODE_SIGNING_ALLOWED=NO`）、`-exportArchive` の配布用署名だけ**を使う（#549）。**Web と iOS は別の run**で、iOS だけ失敗することがある
- 判定だけ確かめる: Actions → iOS TestFlight → Run workflow で `dry_run` にチェック
- 更新不要と判定された版を手動で配布する: 同じく Run workflow で `force` にチェック（issue-deck の「手動で配布」ボタンもこれを使う。`dry_run` が真ならビルドしない）
- 失敗したら、run のサマリーで段階を確かめ、原因を直して「Re-run failed jobs」（または同じ `sha` で再実行）。印は配布し終えたときだけ進むので何度やり直してもよい

| 症状 | 原因と対処 |
|---|---|
| `ASC_KEY_ID が未登録です` | 下の初期設定をしていない |
| `App Store Connect APIの認証に失敗しました（HTTP 401/403）` | キーの失効、または権限不足（「App管理」以上） |
| `Communication with Apple failed` / プロファイル作成失敗 | App ID・配布証明書が未作成。Xcode で一度 Archive して作る |
| `内部グループを1つに決められません` | repository variable `TESTFLIGHT_GROUP` に内部グループ名を入れる |
| 「Apple Development 証明書の上限」「開発用プロファイルが見つからない」でアーカイブが落ちる | チームの開発用証明書が上限に達している。アーカイブを署名なしにしてあるので run では増えないはず。上限に達した状態が残っていたら、[Apple Developer の証明書一覧](https://developer.apple.com/account/resources/certificates/list)で、`Created by Xcode`・`Apple Development` の使っていないものを revoke する（実機用に使っているものは消さない）。それでも run ごとに増えるなら、アーカイブのステップに `-allowProvisioningUpdates` が戻っていないか確認する |
| `MISSING_EXPORT_COMPLIANCE` | `AIDEios-Info.plist` の `ITSAppUsesNonExemptEncryption` を確認 |
| `MARKETING_VERSION がずれています` | `node ios/scripts/sync-version.mjs` を実行して develop へ反映 |

### 初期設定（初回だけ・本人の操作）

1. `sync-secrets.yml` を `only=ASC_KEY_ID,ASC_ISSUER_ID,ASC_KEY_P8` で実行する（キーは kurashio と共通の `op://apps/AppStoreConnect/*`）
2. App Store Connect に Bundle ID `com.gucchii.AIDEios` の App を作り、内部テストグループを用意する（複数なら `TESTFLIGHT_GROUP` を設定）
3. Mac の Xcode で一度 Archive し、App ID・配布証明書を作っておく

**このワークフローは subpc では実行できず、実際の配布は未確認。** 初回は `dry_run` の後、実際の run で各段階を確かめる。

## ビルド SHA の表示（初回のみ Xcode で設定）

アプリの隅（ロック画面）に `build <短いSHA>` を出します。値は Run Script build phase が書くため、次の設定を **Mac の Xcode で 1 回だけ** 行い、`project.pbxproj` の変更をコミットします（未設定のビルドでは「不明」と出ます）。

1. TARGETS の `AIDEios` > **Build Phases** > `+` > **New Run Script Phase**
2. 次を Shell スクリプトに設定する: `"${SRCROOT}/scripts/write-git-sha.sh"`
3. 「Based on dependency analysis」のチェックを外す（毎回実行する）
4. Build Settings の **User Script Sandboxing** を `No` にする（`Yes` のままだと `.git` を読めず、SHA が常に「不明」になる）
5. `MARKETING_VERSION` は AIDE のバージョンに自動同期される（上記「バージョンの同期」）ので、手で揃えない

`write-git-sha.sh` はビルド成果物の Info.plist にだけ書くので、ソースの plist は汚れません。未コミットの変更があるビルドには `-dirty` が付きます。

## 実機で確認する項目

PR 本文の「Xcodeで確認が必要な項目」を上から順に確かめます。よくある項目は次のとおりです。

- **ビルド**: `Cmd + B` でエラーなくビルドできる
- **起動**: 実機で起動し、AIDE の画面が表示される
- **Face ID**: 起動時・復帰時にロック画面が出て、Face ID（または端末パスコード）で解除できる。初回はFace IDの許可ダイアログが出る
- **ログイン保持**: ログイン後にアプリを終了して再起動しても、ロック解除後にログイン状態が復元される
- **URL スキーム**: 認証コールバック（`com.gucchii.aide://`）でアプリに戻れる
- **AIDEリンク**: Safari・メモ等で`https://aide.gucchii.com/...`のリンクを開くとアプリが起動し、対応する画面が開く（AIDE側のAASA配信後）。未ログインでもログイン後に同じ画面へ戻る。`/status/auth`配下や他ドメインのリンクは開かない
- **Signing & Capabilities**: 変更が入った PR では、Team・Bundle ID・Capability に想定外の差分がない

## コマンドラインでビルドする（任意）

CI と同じ条件でシミュレータ向けにビルドするには、次を実行します。

```bash
xcodebuild \
  -project AIDEios.xcodeproj \
  -scheme AIDEios \
  -configuration Debug \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO \
  build
```

## Xcode でファイルを追加・Target を追加するとき

Swift ファイルの追加や Target（Share Extension など）の追加は `project.pbxproj` の変更を伴うため、Linux 側のエージェントは行えません。Mac の Xcode で次のように行い、変更をコミットします。

1. File > New > File（または Target）から追加する
2. 追加先の Target（`AIDEios`）にチェックが入っていることを確認する
3. `git status --short` と `git diff` で、意図した変更だけが入っていることを確認する
4. `xcuserdata/`・`*.xcuserstate`・`.DS_Store`・`DerivedData/` はコミットしない（`.gitignore` 済み）

## 関連ドキュメント

- [CLAUDE.md](CLAUDE.md) — エージェント向けのルール（Linuxでの制約・pbxprojの扱い）
- [../README.md](../README.md) — AIDE 本体
