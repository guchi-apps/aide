#!/opt/homebrew/bin/bash
#
# aide の worker ジョブの LaunchAgent を生成して登録する（#874）。
# deploy/systemd/ の timer・service に当たる。plist はこのスクリプトが表（JOBS）から生成する。
#
#   deploy/macmini/install.sh [ジョブ名...]   # 省略時は全ジョブ。何度流しても同じ結果になる
#   deploy/macmini/install.sh --uninstall      # 登録を全部外す
#
# 登録しても、担当外のジョブは run.ts が何もせず終わる（`AIDE_WORKER_JOBS`）。
# ただし Mac mini の ~/apps/aide/.env に AIDE_WORKER_JOBS を入れてから登録すること。
#
# 差分（systemd との違い）:
#   - Persistent=true に当たるものが無い。停止中の分は取り戻さない（再起動後は次の周期を待つ）。
#   - TimeoutStartSec は run-job.sh の `timeout` で代替する。
#   - OnCalendar の Asia/Tokyo は、Mac mini のタイムゾーンが Asia/Tokyo であることを前提に代替する。
#   - RandomizedDelaySec は無い。`hourly` 系は毎時0分ちょうどに揃う。
set -euo pipefail

[[ "$(uname -s)" == "Darwin" ]] || { echo "macOS 専用です" >&2; exit 1; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
agents="$HOME/Library/LaunchAgents"
logs="$HOME/Library/Logs/aide"
prefix="com.guchi-apps.aide"
domain="gui/$(id -u)"

# ジョブ名|上限秒|スケジュール（StartInterval:<秒> か Calendar:<Hour>:<Minute>[,<Hour>:<Minute>...]。Hour は * で毎時）
JOBS=(
  "self-update|900|Calendar:*:0"
  "weather-sync|120|Calendar:*:0"
  "gmail-watch|120|Calendar:4:0"
  "zaim-keep-alive|900|Calendar:*:0,*:30"
  "zaim-refresh|3300|Calendar:10:30,22:30"
  "zaim-sync|3300|Calendar:11:30,23:30"
  "zaim-money-sync|3300|Calendar:11:30,23:30"
  "claude-sessions-sync|60|StartInterval:120"
  "printer-watch|60|StartInterval:120"
)
# 担当に入れるのは、macOS 対応を確かめたジョブだけにする（既定の登録対象から外すものはここに書く）。
# claude-sessions-sync は /proc を読むため macOS では動かない（別途対応）。
DEFAULT_EXCLUDE=(claude-sessions-sync printer-watch)

calendar_xml() {
  local spec="$1" item hour minute
  echo "  <key>StartCalendarInterval</key>"
  echo "  <array>"
  IFS=',' read -ra items <<< "$spec"
  for item in "${items[@]}"; do
    hour="${item%%:*}"
    minute="${item##*:}"
    echo "    <dict>"
    [[ "$hour" == "*" ]] || echo "      <key>Hour</key><integer>$hour</integer>"
    echo "      <key>Minute</key><integer>$minute</integer>"
    echo "    </dict>"
  done
  echo "  </array>"
}

write_plist() {
  local job="$1" limit="$2" schedule="$3" file="$agents/$prefix.$job.plist"
  {
    cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- install.sh が生成。直接編集せず deploy/macmini/install.sh の表を直して流し直す。 -->
<plist version="1.0">
<dict>
  <key>Label</key><string>$prefix.$job</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/bash</string>
    <string>$here/run-job.sh</string>
    <string>$job</string>
    <string>$limit</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$HOME</string>
    <key>LANG</key><string>ja_JP.UTF-8</string>
    <key>PATH</key><string>/opt/homebrew/opt/node@24/bin:/opt/homebrew/opt/coreutils/libexec/gnubin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>WorkingDirectory</key><string>$HOME</string>
EOF
    case "$schedule" in
      StartInterval:*) echo "  <key>StartInterval</key><integer>${schedule#StartInterval:}</integer>" ;;
      Calendar:*) calendar_xml "${schedule#Calendar:}" ;;
      *) echo "不明なスケジュール: $schedule" >&2; return 1 ;;
    esac
    cat <<EOF
  <key>StandardOutPath</key><string>$logs/$job.log</string>
  <key>StandardErrorPath</key><string>$logs/$job.log</string>
</dict>
</plist>
EOF
  } > "$file"
  plutil -lint "$file" > /dev/null
}

unload() {
  launchctl bootout "$domain/$prefix.$1" 2> /dev/null || true
}

if [[ "${1:-}" == "--uninstall" ]]; then
  for entry in "${JOBS[@]}"; do
    job="${entry%%|*}"
    unload "$job"
    rm -f "$agents/$prefix.$job.plist"
  done
  echo "登録を外しました"
  exit 0
fi

mkdir -p "$agents" "$logs"
requested=("$@")
for entry in "${JOBS[@]}"; do
  IFS='|' read -r job limit schedule <<< "$entry"
  if [[ ${#requested[@]} -gt 0 ]]; then
    [[ " ${requested[*]} " == *" $job "* ]] || continue
  elif [[ " ${DEFAULT_EXCLUDE[*]} " == *" $job "* ]]; then
    echo "- $job: 既定では登録しません（明示すれば登録できます）"
    continue
  fi
  write_plist "$job" "$limit" "$schedule"
  unload "$job"
  launchctl bootstrap "$domain" "$agents/$prefix.$job.plist"
  echo "- $job: 登録しました"
done
