import { buildOpsStatus } from "../../core/views/ops.ts";
import type { Tool } from "../types.ts";

/**
 * 運用状況の横断ビュー。
 *
 * ClaudeアプリはVPS上のAPIへ直接HTTPリクエストできない（実測）。VPSの状態を知る経路は
 * MCPサーバーしかなく、**AIDEにしかできない領域**にあたる。
 *
 * ops-dashboard が束ねている6本のAPI（ホスト指標・Uptime Kuma・UptimeRobot・
 * AI/GitHub/1Password の残枠）を1つの答えに畳むため、README「Core と MCP層の境界」が言う
 * 横断ビューに該当する。単機能ツールではなく、公式MCPとも重複しない。
 */
export const opsStatusTool: Tool = {
  name: "aide_ops_status",
  description:
    "VPS・サブPCの稼働状況を返す。ホストごとの死活とCPU・メモリ・Swap・ディスク・温度、" +
    "落ちている systemd サービス、再起動待ち、外形監視（Uptime Kuma / UptimeRobot）の停止、" +
    "AI・GitHub Actions・1Password の残枠を含む。" +
    "「いまVPSはどうなっているか」「サーバーに異常はないか」「ディスクは足りているか」" +
    "「残枠はどれくらいか」を尋ねられたときに呼ぶ。" +
    "problems に異常が1行ずつ入るので、まずそこを見ること。ok が true なら判定できた範囲で異常なし。" +
    "complete が false のときは取得できなかったソースがあり、判定範囲が限定的であることを意味する" +
    "（材料を1つも取得できなかった場合は ok も false になる。異常の有無は分からないという意味）。" +
    "履歴・上位プロセスは返さない（必要なら ops-dashboard の画面を見る）。" +
    "tmuxセッションは件数だけで、サブPCで動いている Claude Code の内訳と" +
    "リモートコントロールのURLは aide_claude_sessions が返す。",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async () => {
    const status = await buildOpsStatus();
    return {
      content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
      // 未設定・取得失敗は「エラー」ではなく状態。isErrorにするとClaudeが再試行して無駄になる。
      isError: false,
    };
  },
};
