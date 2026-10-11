# AIDE iOS — エージェント向けガイド

このディレクトリは AIDE リポジトリの `ios/`（旧 `guchi-apps/aide-ios` から #525 で統合）。**ブランチ・PR・CI・リリースはルートの `CLAUDE.md` に従う**（iOS 専用の運用は無い）。検証は Node の `npm test`/`npm run typecheck` の対象外で、`ios/scripts/` のスクリプトで行う（下記）。


AIDE（`https://aide.gucchii.com/map`）を表示する iOS アプリのラッパー。SwiftUI + `WKWebView` の Xcode プロジェクト（`AIDEios.xcodeproj`）。


## 構成

**拡張機能は持たない**（#587）。ショートカット／Siri（App Intents）・ホーム画面ウィジェット・プッシュ通知（APNs）は試験導入だけのもので（Swiftはビルドされていたが、entitlementsが署名に未接続でプッシュ・App Group・ウィジェットは動いていなかった）、AIDE側のAPI（`/api/mobile/*`・`/api/room/summary`）ごと削除した。`AIDEios.entitlements`は`applinks:aide.gucchii.com`だけを持つ。**再導入するときは**、pbxprojの`CODE_SIGN_ENTITLEMENTS`・Capabilityの設定をMacのXcodeで行ってから実装する。

- `README.md` — 人向けの Xcode 操作手順（セットアップ・入れ直し・実機確認）。手順を変えるときは CLAUDE.md の該当節と食い違わせない
- `AIDEios/` — Swift ソース（`AIDEiosApp.swift`・`ContentView.swift`）とアセット
  - 認証情報の保護: `AppLock.swift`（起動・復帰時のロック状態）・`BiometricGate.swift`（Face ID／パスコードによる本人確認）・`SessionVault.swift`（ログインCookieのKeychain保存・復元・ログアウト時の全消去）・`KeychainStore.swift`（Keychainの薄いラッパー）・`LockView.swift`（ロック画面）。Cookie値・トークンは**ログへ出さない**（`Logger`にはOSStatusと固定文言だけ）
  - ビルド表示: `BuildInfo.swift`が`v<バージョン> (build <ビルド番号>)`（Info.plistの`CFBundleShortVersionString`・`CFBundleVersion`）を組み立て、`LockView.swift`の隅に出す。設定なしで必ず出る。`AIDEGitSHA`は Run Script build phase が`scripts/write-git-sha.sh`でビルド成果物のInfo.plistへ書いたときだけ末尾に`· <SHA>`として足す（build phaseの登録はpbxprojの変更なのでMac側で行う。未登録ならSHAは出ない）
  - AIDEリンクの受け口: `DeepLink.swift`（`AIDERoute`が`https://aide.gucchii.com`配下のURLか`com.gucchii.aide://open?path=/...`だけを検証して通し、`/status/auth`・`/auth`・`..`などは捨てる。`DeepLinkRouter`が開く画面を保持し、ロック中・未ログイン中は解除後にWebViewが読む。未ログインはAIDEが認証へ誘導するので`next`経由で元の画面へ戻る）。Universal Links・カスタムURLスキームは`AIDERoute`を経由する。Universal Linksには`AIDEios.entitlements`の`applinks:aide.gucchii.com`と、AIDE側の`/.well-known/apple-app-site-association`配信が要る
  - 認証コールバックの検証: `AuthCallback.swift`（`code(from:scheme:path:)`。認証コールバックURL〔`com.gucchii.aide:/auth/callback?code=...`〕のスキーム・ホスト（無し）・パス・`error`の有無・`code`の形式〔43文字のbase64url〕を確認する純粋関数。通常ログイン〔`ContentView.swift`のCoordinator〕が使う。Keychain・WebKitに依存しないため`AIDEiosTests`で直接テストできる）
- `AIDEiosTests/` — Unit Testのソース（`AIDERouteTests.swift`・`AuthCallbackTests.swift`）。いずれもKeychain・WebKitに依存しない純粋関数の受理・拒否ケースを表形式で確認する。Unit Testing BundleのTargetはXcodeで追加する（`project.pbxproj`は手編集しない。#68時点では未追加）
- `scripts/install-to-iphone.sh`・`scripts/remote-install.sh` — Mac mini で `main` を取り込み実機へ入れ直す／subpc から SSH で呼ぶ
- `scripts/remote-build-check.sh` — subpc の作業ツリーの `ios/` を Mac へ送り、署名なしでビルドが通るかだけ確かめる（コミット前の確認用）
- `scripts/check-consistency.mjs`・`scripts/sync-version.mjs`・`scripts/ios-changes.mjs` — バージョン・ログイン戻り先の照合／MARKETING_VERSION の同期／入れ直し要否の判定
- `scripts/write-git-sha.sh` — Run Script build phase用。ビルドSHAを成果物のInfo.plistへ書く
- `scripts/check-swift-imports.sh` — Linuxでも動く明示importの漏れ検出（下記「明示importの規則」）
- `AIDEios-Info.plist` — 明示的な Info.plist（`GENERATE_INFOPLIST_FILE = NO`・`INFOPLIST_FILE` で参照）。URL スキーム（認証コールバック）などのキーはここに書く
- `AIDEios.xcodeproj/` — Xcode プロジェクト（`project.pbxproj` を含む）
- Bundle ID: `com.gucchii.AIDEios` / 署名: Automatic

## Linux（サブPC）での制約

Issue Deck からサブPC（Ubuntu・Linux）の Codex／Claude Code に渡された実装は、**Swift ソースの編集までしかできない**。Xcode・iOS SDK・署名用の証明書がなく、次の操作は実行できない。

- `xcodebuild`（ビルド・テスト）
- 署名・Provisioning Profile の確認
- シミュレータ・実機での動作検証

したがって **ビルドの成功を装わない**。PR 本文・Issue コメントには「ビルドしていない」「実機で確認していない」と事実のまま書く。構文チェックや目視レビューをしたなら、それが何であって何ではないかを区別して書く。

### 明示importの規則（`MEMBER_IMPORT_VISIBILITY`）

`project.pbxproj`で`SWIFT_UPCOMING_FEATURE_MEMBER_IMPORT_VISIBILITY = YES`のため、別モジュールの拡張メンバーを使うファイルはそのモジュールを**自分で**importする。`import SwiftUI`では補われない。

- `ObservableObject`・`@Published`・`AnyCancellable`などを使うファイルは`import Combine`を書く（既存の`AppLock.swift`・`DeepLink.swift`と同じ）。落とすと`type '...' does not conform to protocol 'ObservableObject'`・`missing import of defining module 'Combine'`でCIが失敗する（PR #35）
- **PRを作る前に`scripts/check-swift-imports.sh`を実行し、`OK`になることを確かめる。** 既知の漏れだけを見るもので、ビルドの代わりにはならない。新しい種類の漏れでCIが落ちたら、スクリプトの`RULES`へ足す

### Xcode で確認が必要な項目

次の項目は Linux では確かめられない。**変更が触れるかどうかにかかわらず、PR 本文に「Xcodeで確認が必要な項目」の節を設けて、関係するものを列挙する。** 何も該当しないときも、その節に「該当なし（Swift ソースのみの変更・ビルド未確認）」と書く。

- Signing & Capabilities（Team・Bundle ID・Capability の追加削除）
- Share Extension など Target の追加
- Associated Domains
- Face ID（`NSFaceIDUsageDescription` を含む）
- カメラ権限（`NSCameraUsageDescription` を含む）
- 上記以外の `AIDEios-Info.plist` キー（URL スキームを含む）・entitlements の追加。plist は Linux でも編集できるが、Xcode で読み込めて実機で反映されるかは確かめられない
- Run Script build phase（`scripts/write-git-sha.sh`）の登録とビルドSHAの表示・`User Script Sandboxing` の無効化（pbxprojの変更。README「ビルド SHA の表示」）
- ビルドが通ること、実機で起動して意図どおり動くこと

### `project.pbxproj` の扱い

`AIDEios.xcodeproj/project.pbxproj` は Xcode が管理するファイルで、手編集は壊れやすい。原則は編集せず、Target 追加やファイル登録など pbxproj の変更が要る作業は「Xcodeで確認が必要な項目」に回して Mac 側で行う。

やむを得ず手で編集した場合は、**編集した旨と変更の意図を PR 本文に書く**（どの項目をなぜ変えたか）。Xcode で開いたときに読み込めるかは Linux では確認できないので、これも Xcode で確認が必要な項目に入れる。

### コミットしないもの

- `xcuserdata/`・`*.xcuserstate`・`.DS_Store`・`DerivedData/`（`.gitignore` 済み。増やさない）
- シークレット（API キー・トークン・証明書・Provisioning Profile・`.p12` など）。実シークレットをリポジトリ・PR・Issue に残さない

## ブランチ・CI・リリース

- ブランチ・PR・マージ・リリースは AIDE 本体と同じ（`develop` 向けPR→`main` へのリリース）。旧 aide-ios の「`main`＝実機に入れた版」運用は廃止した
- CI（ubuntu）は毎回 `ios/scripts/check-consistency.mjs`・`check-swift-imports.sh`・`ios/scripts/*.test.mjs` を実行する。**macOS runner での `xcodebuild` は無い**（ビルドの確認は Mac mini での入れ直し）
- バージョン（`MARKETING_VERSION`）は package.json の version に同期する。リリースのバンプPRが `scripts/sync-version.mjs` を呼ぶので手で書き換えない
- iOS の配布物（`AIDEios/`・`AIDEios.xcodeproj/`・`AIDEios-Info.plist`）が変わる develop→main のPRには、`ios-rebuild-notice.yml` が「入れ直しが必要」とコメントする。入れ直しは `main` から `scripts/remote-install.sh`（手順は README）
- TestFlight へは main の `Deploy to Production` 成功後に `ios-testflight-trigger.yml` → `ios-testflight.yml` が自動配布する（配布物が変わったリリースだけ・#530）。**subpc では動作を確かめられない**（Xcode・App Store Connect の実キーが要る）。配布済みの印はタグ `ios-testflight/<ビルド番号>`。手順・失敗時の対処は README「TestFlight への自動配布」

