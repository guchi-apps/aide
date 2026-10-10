#!/usr/bin/env bash
# Swiftソースの明示importの漏れを検出する（Linuxでも実行できる。#36）
#
# project.pbxproj で SWIFT_UPCOMING_FEATURE_MEMBER_IMPORT_VISIBILITY = YES のため、
# 別モジュールの拡張メンバーを使うファイルはそのモジュールを自分でimportしないと
# ビルドエラーになる（SwiftUIをimportしていても補われない）。
# 例: ObservableObject・@Published は Combine が要る（#35のCI失敗）。
#
# xcodebuildの代わりにはならない。Linuxで気付ける既知の漏れだけを見る。
#
# 使い方: scripts/check-swift-imports.sh [ファイル...]（省略時は AIDEios/ 全体）

set -euo pipefail

cd "$(dirname "$0")/.."

# "使っている記述の正規表現|必要なモジュール" の組。見つけた漏れはここへ足す。
RULES=(
  '\bObservableObject\b|@Published\b|\bAnyCancellable\b|\bPassthroughSubject\b|\bCurrentValueSubject\b|Combine'
)

if [[ $# -gt 0 ]]; then
  files=("$@")
else
  mapfile -t files < <(find AIDEios -name '*.swift' 2>/dev/null | sort)
fi

status=0
for file in "${files[@]}"; do
  # 行コメントを除いた本文で判定する
  body="$(sed -E 's#^[[:space:]]*//.*$##' "$file")"
  for rule in "${RULES[@]}"; do
    pattern="${rule%|*}"
    module="${rule##*|}"
    if grep -qE "$pattern" <<<"$body" && ! grep -qE "^[[:space:]]*(@[A-Za-z_]+[[:space:]]+)*import[[:space:]]+$module\b" "$file"; then
      echo "$file: '$module' をimportしていません（${pattern//\\b/} を使用）" >&2
      status=1
    fi
  done
done

if [[ $status -eq 0 ]]; then
  echo "OK: ${#files[@]} ファイル"
fi
exit $status
