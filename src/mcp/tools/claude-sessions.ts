import { buildClaudeSessionsStatus } from "../../core/views/claude-sessions.ts";
import type { Tool } from "../types.ts";

/**
 * サブPCで動いている Claude Code セッションの一覧。
 *
 * **AIDEにしかできない領域**にあたる。台帳はサブPCのファイルシステムにしかなく、
 * Claudeアプリからそこを読む経路は他に無い。公式MCPとも重複しない。
 *
 * `aide_ops_status` とは問いが違う。あちらは「サーバーに異常はないか」で、tmuxセッションの
 * 詳細は意図して返していない。こちらは「どのセッションが動いていて、どこへ飛べばよいか」に
 * だけ答える。**リモートコントロールのURLをそのまま返すのが要点**で、チャットから
 * タップすればそのセッションの画面へ行ける。
 */
export const claudeSessionsTool: Tool = {
  name: "aide_claude_sessions",
  description:
    "サブPCで動作中の Claude Code セッションの一覧を返す。" +
    "セッションごとにリモートコントロールのURL（remoteControlUrl。開くとそのセッションを" +
    "操作できる）、プロジェクト名、作業ディレクトリ、tmuxセッション名、" +
    "状態（status: busy=応答中 / idle=待機中）、起動からの経過分数（runningForMinutes）、" +
    "その状態が続いている分数（statusForMinutes）を含む。" +
    "「サブPCでいま何が動いているか」「Claude Codeのセッションを開きたい」" +
    "「リモートコントロールのURLを教えて」「放置しているセッションはないか」" +
    "を尋ねられたときに呼ぶ。" +
    "**答えるときは remoteControlUrl をそのままリンクとして示すこと**（利用者はそれをタップして" +
    "セッションへ移動する）。null のセッションはリモートコントロールが確立しておらず開けない。" +
    "一覧は2分ごとに集めたスナップショットで、collectedAt がその時刻、" +
    "snapshotAgeMinutes が経過分数。stale が true のときは収集が止まっており、" +
    "載っているセッションが既に終了している可能性がある（動いていないという意味ではない）。" +
    "会話の中身・実行したツール・トークン使用量は返さない。" +
    "サーバーの稼働状況そのものは aide_ops_status を使う。",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async () => {
    const status = await buildClaudeSessionsStatus();
    return {
      content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
      // 未収集・古いキャッシュは「エラー」ではなく状態。isErrorにするとClaudeが再試行して無駄になる。
      isError: false,
    };
  },
};
