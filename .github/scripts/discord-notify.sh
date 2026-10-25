#!/usr/bin/env bash
# CI / デプロイ / リリース / TestFlight の異常を Discord へ通知するスクリプト（GitHub Actions 用）
#
# Signaly 廃止に伴う置き換え（#710。worker側は #702）。**送るのは失敗だけ**で、
# success・cancelled などは何も送らず終了する（異常だけを知らせる方針）。
#
# Requires: AIDE_DISCORD_WEBHOOK_URL, NOTIFY_STATUS
# Optional: NOTIFY_APP, NOTIFY_KIND (e.g. デプロイ / CI / リリース), NOTIFY_JOB, NOTIFY_VERSION
#
# **どう転んでも終了コードは0で返す。** 通知先が落ちていても、本体のrunを通知のせいで赤くしない。
# ただし未設定のときは `::warning::` を出し、「通知が届かない」ことをrunの画面で観測できるようにする。
set -euo pipefail

status="${NOTIFY_STATUS:-unknown}"

if [[ "$status" != "failure" ]]; then
  echo "異常ではないため通知しません (status=${status})"
  exit 0
fi

webhook_url="${AIDE_DISCORD_WEBHOOK_URL:-}"
if [[ -z "$webhook_url" ]]; then
  echo "::warning::AIDE_DISCORD_WEBHOOK_URL が未設定のため、失敗をDiscordへ通知できません"
  exit 0
fi

export NOTIFY_APP="${NOTIFY_APP:-}"
export NOTIFY_KIND="${NOTIFY_KIND:-}"
export NOTIFY_JOB="${NOTIFY_JOB:-}"
export NOTIFY_VERSION="${NOTIFY_VERSION:-}"
export NOTIFY_WORKFLOW="${NOTIFY_WORKFLOW:-${GITHUB_WORKFLOW:-GitHub Actions}}"
export RUN_URL="${NOTIFY_RUN_URL:-${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}}"

payload=$(python3 - <<'PY'
import json
import os

app = os.environ.get("NOTIFY_APP", "")
kind = os.environ.get("NOTIFY_KIND", "")
version = os.environ.get("NOTIFY_VERSION", "")
job = os.environ.get("NOTIFY_JOB", "")
workflow = os.environ["NOTIFY_WORKFLOW"]
repository = os.environ.get("GITHUB_REPOSITORY", "")
ref_name = os.environ.get("GITHUB_REF_NAME", "")
sha = os.environ.get("GITHUB_SHA", "")[:7]
actor = os.environ.get("GITHUB_ACTOR", "")

label = f"[{app}] " if app else ""
title = f"❌ {label}{kind or workflow} 失敗"

fields = []
for name, value, code in [
    ("Version", version, True),
    ("Repository", repository, True),
    ("Branch", ref_name, False),
    ("Commit", sha, True),
    ("Actor", actor, False),
    ("Job", job, False),
]:
    if value:
        fields.append({"name": name, "value": f"`{value}`" if code else value, "inline": True})
fields.append({"name": "Run", "value": f"[Workflow Run]({os.environ['RUN_URL']})", "inline": False})

# src/worker/notify.ts の COLOR_FAILURE と同じ赤。
print(json.dumps({"embeds": [{"title": title, "color": 0xED4245, "fields": fields}]}))
PY
)

# curlのstderrは出さない（接続失敗時のメッセージにwebhookのホスト名が載り、PUBLICなrunのログへ残るため）。
# 代わりにHTTPコードとcurlの終了コードだけを出す。
http_code=""
curl_status=0
http_code="$(curl -fsS -o /dev/null -w '%{http_code}' \
  --max-time 10 --retry 2 --retry-delay 2 \
  -H "Content-Type: application/json" \
  -d "$payload" \
  "$webhook_url" 2>/dev/null)" || curl_status=$?

if [[ "$curl_status" -eq 0 ]]; then
  echo "Discordへ通知しました (HTTP ${http_code})"
  exit 0
fi

echo "::warning::Discordへの通知に失敗しました (HTTP ${http_code:-000} / curl exit ${curl_status})。このrunは通知の失敗では落としません"
exit 0
