# AIDE iOS — エージェント向けガイド

このディレクトリは AIDE リポジトリの `ios/`（旧 `guchi-apps/aide-ios` から #525 で統合）。**ブランチ・PR・CI・リリースはルートの `CLAUDE.md` に従う**（iOS 専用の運用は無い）。検証は Node の `npm test`/`npm run typecheck` の対象外で、`ios/scripts/` のスクリプトで行う（下記）。


AIDE（`https://aide.gucchii.com/map`）を表示する iOS アプリのラッパー。SwiftUI + `WKWebView` の Xcode プロジェクト（`AIDEios.xcodeproj`）。


## 構成

**pbxproj未接続（2026-09時点、#66）**: `AIDEios`ターゲットのビルド設定に`CODE_SIGN_ENTITLEMENTS`が無く、`AIDEios.entitlements`（`aps-environment`・`applinks:aide.gucchii.com`・`group.com.gucchii.AIDEios`）が署名に入っていない。Widget Extensionのターゲットも無い。このため、下記のプッシュ通知・Universal Links・App Group共有・ウィジェットは、実装済みのSwiftソースがあっても実機では動かない。Mac の Xcode で Signing & Capabilities（Push Notifications・Associated Domains・App Groups）と Widget Extension ターゲットの追加、Run Script build phase の登録を行い、`project.pbxproj`をコミットするまでこの状態が続く。

- `README.md` — 人向けの Xcode 操作手順（セットアップ・入れ直し・実機確認）。手順を変えるときは CLAUDE.md の該当節と食い違わせない
- `AIDEios/` — Swift ソース（`AIDEiosApp.swift`・`ContentView.swift`）とアセット
  - 認証情報の保護: `AppLock.swift`（起動・復帰時のロック状態）・`BiometricGate.swift`（Face ID／パスコードによる本人確認）・`SessionVault.swift`（ログインCookieのKeychain保存・復元・ログアウト時の全消去）・`KeychainStore.swift`（Keychainの薄いラッパー）・`LockView.swift`（ロック画面）。Cookie値・トークンは**ログへ出さない**（`Logger`にはOSStatusと固定文言だけ）
  - ウィジェット: `RoomSnapshot.swift`（App Group `group.com.gucchii.AIDEios` 共有の室温スナップショット。Widget Extensionにも含める）・`RoomFetcher.swift`（本人確認後にCookieで室温を取得して保存）。ウィジェットは通信もログイン情報の参照もせず、保存値だけを表示する
  - ビルドSHAの表示: `BuildInfo.swift`（Info.plistの`AIDEGitSHA`を読む）を`LockView.swift`の隅に出す。値は Run Script build phase が`scripts/write-git-sha.sh`でビルド成果物のInfo.plistへ書く（build phaseの登録はpbxprojの変更なのでMac側で行う。未登録なら「不明」と出る）
  - AIDEリンクの受け口: `DeepLink.swift`（`AIDERoute`が`https://aide.gucchii.com`配下のURLか`com.gucchii.aide://open?path=/...`だけを検証して通し、`/status/auth`・`/auth`・`..`などは捨てる。`DeepLinkRouter`が開く画面を保持し、ロック中・未ログイン中は解除後にWebViewが読む。未ログインはAIDEが認証へ誘導するので`next`経由で元の画面へ戻る）。Universal Links・ウィジェット（`widgetURL`）・通知（`userInfo["url"]`）・App Intentsはいずれも`AIDERoute`を経由する。Universal Linksには`AIDEios.entitlements`の`applinks:aide.gucchii.com`と、AIDE側の`/.well-known/apple-app-site-association`配信が要る
  - ショートカット／Siri（App Intents）: `RoomTemperatureIntent.swift`（室温を確認するIntentと`AppShortcutsProvider`）・`AIDEClient.swift`（AIDEの`/api/mobile/room-temperature`をBearerで呼ぶ。myroomへは直接接続しない）・`IntentTokenStore.swift`（Intent用トークンのKeychain保存。バックグラウンドで動くためFace ID不要の項目。ASCII表示可能文字だけ保存できる）・`IntentTokenSettingsView.swift`（トークンを貼り付けて保存・削除する設定画面。ロック解除後の歯車ボタンから開く。値は再表示しない。iCloudキーチェーンの保存提案が出ないよう`textContentType`は付けない。「ログインして取得」ボタンが`MobileTokenIssuer.swift`（`scope=mobile`のPKCEログイン→`POST /api/mobile/token`）でトークンを自動発行して保存する。貼り付けは手動の代替。値・code・verifierは**ログへ出さない**）。AIDE側のAPIは`guchi-apps/aide#454`で用意する
  - 認証コールバックの検証: `AuthCallback.swift`（`code(from:scheme:path:)`。認証コールバックURL〔`com.gucchii.aide:/auth/callback?code=...`〕のスキーム・ホスト（無し）・パス・`error`の有無・`code`の形式〔43文字のbase64url〕を確認する純粋関数。通常ログイン〔`ContentView.swift`のCoordinator〕とショートカット用トークン発行〔`MobileTokenIssuer.swift`〕の両方が共有する。Keychain・WebKitに依存しないため`AIDEiosTests`で直接テストできる）
  - プッシュ通知（APNs）: `PushNotifications.swift`（通知許可の取得・デバイストークンの登録／更新／失効・通知タップの受け取り・`AppDelegate`）・`PushRegistrar.swift`（AIDEの`/api/mobile/push/devices`へBearerで登録・失効。トークンはIntentと共通の`IntentTokenStore`）・`NotificationKind.swift`（通知種別ごとのオン・オフ設定の保存。設定UIは未実装）。通知payloadの`path`（AIDE配下の相対パス）は`DeepLinkRouter.handle(path:)`経由で`AIDERoute`の検証を通し、本人確認後にWebViewで開く（`AppDelegate`から触るため`DeepLinkRouter.shared`を使う）。デバイストークン・通知本文は**ログへ出さない**。AIDE側のAPI・送信経路は`guchi-apps/aide#463`
- `AIDEiosWidget/` — Widget Extension のソース（`RoomWidget.swift`）と entitlements。Target は Xcode で追加する（`project.pbxproj` は手編集しない）
- `AIDEiosTests/` — Unit Testのソース（`AIDERouteTests.swift`・`IntentTokenStoreTests.swift`・`AuthCallbackTests.swift`）。いずれもKeychain・WebKitに依存しない純粋関数の受理・拒否ケースを表形式で確認する。Unit Testing BundleのTargetはXcodeで追加する（`project.pbxproj`は手編集しない。#68時点では未追加）
- `scripts/install-to-iphone.sh`・`scripts/remote-install.sh` — Mac mini で `main` を取り込み実機へ入れ直す／subpc から SSH で呼ぶ
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
- Widget Extension・Share Extension など Target の追加
- Push Notifications
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
- iOS の配布物（`AIDEios/`・`AIDEiosWidget/`・`AIDEios.xcodeproj/`・`AIDEios-Info.plist`）が変わる develop→main のPRには、`ios-rebuild-notice.yml` が「入れ直しが必要」とコメントする。入れ直しは `main` から `scripts/remote-install.sh`（手順は README）
- TestFlight への自動配布は未整備（kurashio には有る。別Issue）

