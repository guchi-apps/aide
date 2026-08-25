#!/usr/bin/env bash
#
# src/web/icons/icon.svg から、配信するPNGを書き出す。
#
# アイコンの正は src/web/icons/icon.svg の1枚だけ。ここで書き出したPNGはその写しなので、
# 絵を直すときはSVGだけを直してこのスクリプトを流し、生成物ごとコミットする
# （PNGを直接編集すると、次にこれを流した時点で戻る）。
#
# **生成物をコミットするため、CI・本番ではこのスクリプトも下のコマンドも要らない。**
# このリポジトリは実行時依存ゼロを保っており、実行時に画像を加工しないのはそのため
# （詳細はREADME「アイコンとPWAマニフェスト」）。
#
# 実行に必要なもの:
#   sudo apt install librsvg2-bin
#
# 書き出すサイズは src/web/assets.ts の ICONS と対応している。片方だけ増やすと
# src/web/assets.test.ts が「宣言したアイコンが実在しない」で落ちる。
#
set -euo pipefail

cd "$(dirname "$0")/.."

src="src/web/icons/icon.svg"
[ -f "$src" ] || { echo "$src が見つかりません" >&2; exit 1; }

command -v rsvg-convert >/dev/null || {
  echo "rsvg-convert がありません。sudo apt install librsvg2-bin" >&2
  exit 1
}

render() { # render <サイズ> <出力先のファイル名>
  rsvg-convert --width "$1" --height "$1" --output "src/web/icons/$2" "$src"
  echo "  src/web/icons/$2 (${1}x${1})"
}

echo "$src から書き出します"
render 512 icon-512.png
render 192 icon-192.png
# iOSのホーム画面用。180pxがApple指定のサイズ。
render 180 apple-touch-icon.png
# ブラウザのタブ用。/favicon.ico にもこれを返している。
render 32 favicon-32.png

echo "完了しました。生成物もコミットしてください。"
