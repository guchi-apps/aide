import { collectClaudeCodeSessions } from "../../core/connectors/claude-code/index.ts";
import { type PublishOptions, publish } from "../sink.ts";

/** Claude Code セッションのキャッシュキー。参照側（横断ビュー）と受け口（ingest）が共有する。 */
export const CLAUDE_SESSIONS_CACHE_KEY = "claude-sessions";

/**
 * 2分ごとに走り `TimeoutStartSec=1min` なので再試行しない。次の実行がやり直しになる（#295）。
 */
export const CLAUDE_SESSIONS_PUBLISH: PublishOptions = { attempts: 1 };

/**
 * サブPCで動いている Claude Code のセッションを集めてキャッシュを更新する。
 *
 * **取得そのものは極めて軽い**（小さなJSONを数件読むだけ）。それでもキャッシュを挟むのは、
 * 台帳が**サブPCのファイルシステムにしか無い**ため。MCPサーバーはVPSで動いており、
 * 呼ばれたときに読みに行くことができない（README「worker とサーバーが別マシンである問題」）。
 *
 * そのぶん鮮度はジョブ間隔ぶん遅れる。参照側は収集時刻を必ず併せて返し、
 * 「いつ時点の一覧か」が分かるようにしてある。
 */
export async function runClaudeSessionsSync(): Promise<string> {
  const snapshot = await collectClaudeCodeSessions();
  const destination = await publish(
    CLAUDE_SESSIONS_CACHE_KEY,
    "claude-code",
    snapshot,
    CLAUDE_SESSIONS_PUBLISH,
  );

  // **セッション名・作業ディレクトリ・リモートコントロールURLはログに出さない。**
  // URLは開けばそのセッションを操作できるもので、systemd のジャーナルへ残す粒度ではない。
  const remote = snapshot.sessions.filter((session) => session.remoteControlUrl !== null).length;
  const unreadable = snapshot.unreadable > 0 ? `（読めなかった台帳 ${snapshot.unreadable}件）` : "";
  return `${snapshot.sessions.length}件のセッション（リモートコントロール可 ${remote}件）を集め、${destination}${unreadable}`;
}
