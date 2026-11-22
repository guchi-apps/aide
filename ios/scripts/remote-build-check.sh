#!/usr/bin/env bash
# subpc の作業ツリーの ios/ を Tailscale 越しに Mac へ送り、署名なしでビルドできるか確かめる（guchi-apps/issue-deck#4378 で issue-deck から配布）。
# subpc に Xcode が無いため、Swift の変更をコミットする前に「コンパイルが通るか」を見る用途。
# 署名・アーカイブ・TestFlightへのアップロードはしない（それは remote-upload-testflight.sh / CI）。
#
#   ios/scripts/remote-build-check.sh
#
# 環境変数（すべて任意）:
#   MAC_HOST      SSH先（既定 guchimac-mini）。`local` を指定するか、`uname -s` が Darwin（Mac自身で実行）なら
#                 SSHせずその場でビルドする（rsync先もローカル）
#   MAC_WORK_DIR  Mac 上の作業ディレクトリ（既定 /tmp/aide-ios-build-check）。毎回この中身を置き換える
#
# 実機での動作（日本語入力・キーボード・TestFlightからの起動）はここでは確かめられない。
set -euo pipefail

if [ "${MAC_HOST:-}" = "local" ] || { [ -z "${MAC_HOST:-}" ] && [ "$(uname -s)" = "Darwin" ]; }; then
  LOCAL=1
else
  LOCAL=0
  HOST="${MAC_HOST:-guchimac-mini}"
fi
WORK_DIR="${MAC_WORK_DIR:-/tmp/aide-ios-build-check}"
IOS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Mac側のログインシェルは zsh で PIPESTATUS が無い。`bash -l -s` に stdin でスクリプトを渡し、
# pipefail でビルド失敗の終了コードを確実に返す（ローカルも同じスクリプトを bash で流す）
build_script() {
  cat <<SCRIPT
set -euo pipefail
cd '$WORK_DIR/ios'
xcodebuild \\
  -project AIDEios.xcodeproj -scheme AIDEios -configuration Debug \\
  -destination 'generic/platform=iOS Simulator' \\
  -derivedDataPath '$WORK_DIR/DerivedData' \\
  CODE_SIGNING_ALLOWED=NO build 2>&1 | tail -n 8
SCRIPT
}

if [ "$LOCAL" = 1 ]; then
  mkdir -p "$WORK_DIR"
  rsync -a --delete --exclude build --exclude DerivedData "$IOS_DIR/" "$WORK_DIR/ios/"
  build_script | bash -l -s
else
  ssh "$HOST" "mkdir -p '$WORK_DIR'"
  rsync -az --delete --exclude build --exclude DerivedData "$IOS_DIR/" "$HOST:$WORK_DIR/ios/"
  build_script | ssh "$HOST" "bash -l -s"
fi
