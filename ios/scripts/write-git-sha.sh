#!/bin/sh
# Xcodeの Run Script build phase から呼ぶ。ビルドしたgitの短いSHAを、**ビルド成果物の**
# Info.plist（AIDEGitSHA）へ書き込む。ソースのAIDEios-Info.plistは書き換えない
# （書き換えるとビルドのたびに作業ツリーが汚れ、xcode-release.shが止まる）。
# 作業ツリーに未コミットの変更があるときは末尾に -dirty を付ける。
set -eu

PLIST="${TARGET_BUILD_DIR}/${INFOPLIST_PATH}"
PLISTBUDDY=/usr/libexec/PlistBuddy

SHA="$(git -C "${SRCROOT}" rev-parse --short HEAD 2>/dev/null || echo unknown)"
if [ "$SHA" != unknown ] && [ -n "$(git -C "${SRCROOT}" status --porcelain 2>/dev/null)" ]; then
  SHA="${SHA}-dirty"
fi

"$PLISTBUDDY" -c "Set :AIDEGitSHA $SHA" "$PLIST" 2>/dev/null \
  || "$PLISTBUDDY" -c "Add :AIDEGitSHA string $SHA" "$PLIST"
echo "AIDEGitSHA=$SHA"
