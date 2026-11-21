#!/opt/homebrew/bin/bash
#
# Mac mini（macOS）で aide の worker ジョブを1回走らせる薄いラッパー（#874）。
# systemd の `ExecStart=/bin/bash -lc 'cd %h/apps/aide && node ... run.ts <job>'` と
# `TimeoutStartSec=` に当たる。launchd には後者が無いため、ここで `timeout` を掛ける。
#
#   run-job.sh <ジョブ名> <上限秒>
#
# 担当ホストの判定は run.ts（`AIDE_WORKER_JOBS`）が行う。担当外なら何もせず0で終わる。
# PATH は Homebrew の node@24 と GNU coreutils（`timeout`）を先頭に並べ直す
# （`bash -l` の path_helper が並べ替えるため。issue-deck の run-with-env.sh と同じ事情）。
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "使い方: $0 <ジョブ名> <上限秒>" >&2
  exit 2
fi
job="$1"
limit="$2"

for dir in /opt/homebrew/opt/node@24/bin /opt/homebrew/opt/coreutils/libexec/gnubin /opt/homebrew/bin; do
  [[ -d "$dir" ]] || continue
  PATH="$dir:${PATH//":$dir"/}"
done
export PATH

cd "$HOME/apps/aide"
# 上限を超えたら TERM、10秒後も残っていれば KILL（systemd の TimeoutStartSec と同じ振る舞い）。
exec timeout --kill-after=10 "$limit" node --env-file-if-exists=.env src/worker/run.ts "$job"
