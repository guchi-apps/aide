#!/opt/homebrew/bin/bash
#
# Mac mini（macOS）で Zaim Web版登録の受け口（常駐）を起動する（#886）。
# systemd の aide-zaim-web.service の ExecStart に当たる。再起動は launchd の KeepAlive が行う。
#
#   run-zaim-web.sh
#
# 担当ホストの判定は無い（worker ジョブではない）。**登録した時点でこの機が受け口になる**ため、
# サブPCの aide-zaim-web.service を止めてから明示的に登録する（README「担当ホストを付け替える順序」）。
set -euo pipefail

for dir in /opt/homebrew/opt/node@24/bin /opt/homebrew/bin; do
  [[ -d "$dir" ]] || continue
  PATH="$dir:${PATH//":$dir"/}"
done
export PATH

cd "$HOME/apps/aide"
exec node --env-file-if-exists=.env src/worker/zaim-web-server.ts
