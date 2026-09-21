import { buildOpsStatus } from "../../core/views/ops.ts";
import type { OpsProblemSource, OpsStatus } from "../../core/views/ops.ts";
import type { Tool, ToolResult } from "../types.ts";

/**
 * 運用状況の読み取り（#373）。
 *
 * ClaudeアプリはVPS上のAPIへ直接HTTPリクエストできない（実測）。VPSの状態を知る経路は
 * MCPサーバーしかなく、**AIDEにしかできない領域**にあたる。
 *
 * **区画ごとに3本へ分けている。** 以前は `aide_ops_status` 1本で、ホスト指標・外形監視・
 * 各サービスの残枠をまとめて返していた。「残枠はどれくらい」と聞かれただけでCPU・メモリ・
 * ディスク・systemd の全ホストぶんまで返っており、問いに対して応答が大きすぎた。
 *
 * **取得元（`buildOpsStatus()`）は3本とも共通で、ops-dashboard を1回叩く。** Core は
 * 変えず、MCP層で自分の区画だけを切り出す。3本まとめて呼ばれると取得が3回になるが、
 * localhost へのHTTP GETなので許容する（README「どこまでを『重い取得』とみなすか」）。
 */

function json(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    // 未設定・取得失敗は「エラー」ではなく状態。isErrorにするとClaudeが再試行して無駄になる。
    isError: false,
  };
}

/**
 * 区画ひとつぶんの共通の枠。
 *
 * **`ok` はその区画だけで判定し直す。** 全体の `ok` をそのまま渡すと、残枠だけを尋ねられた
 * ときに別ホストのディスク逼迫で `false` になり、問いと関係ない理由で「異常あり」と読まれる。
 * `judged` は判定の材料があったかで、材料が無い状態は「異常が無い」ではない。
 */
function section(
  status: OpsStatus,
  source: OpsProblemSource,
  judged: boolean,
): Record<string, unknown> {
  const problems = status.problems.filter((problem) => problem.source === source);
  return {
    checkedAt: status.checkedAt,
    configured: status.configured,
    ok: judged && problems.length === 0,
    complete: status.complete,
    problems,
    unavailable: status.unavailable,
    note: status.note,
  };
}

export const hostStatusTool: Tool = {
  name: "aide_host_status",
  description:
    "VPS・サブPCのホストごとの稼働状況を返す。死活とCPU・メモリ・Swap・ディスク・温度、" +
    "落ちている systemd サービス、再起動待ち、セキュリティ更新の件数を含む。" +
    "「いまVPSはどうなっているか」「サーバーに異常はないか」「ディスクは足りているか」" +
    "「落ちているサービスはないか」を尋ねられたときに呼ぶ。" +
    "problems に異常が1行ずつ入るので、まずそこを見ること。ok が true なら判定できた範囲で異常なし。" +
    "complete が false のときは取得できなかったソースがあり、判定範囲が限定的であることを意味する。" +
    "履歴・上位プロセスは返さない（必要なら ops-dashboard の画面を見る）。" +
    "**外形監視は aide_uptime_monitors、AI・GitHub・1Password の残枠は aide_service_quotas。**" +
    "tmuxセッションは件数だけで、サブPCで動いている Claude Code の内訳と" +
    "リモートコントロールのURLは aide_claude_sessions が返す。",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async () => {
    const status = await buildOpsStatus();
    return json({ ...section(status, "hosts", status.hosts.length > 0), hosts: status.hosts });
  },
};

export const uptimeMonitorsTool: Tool = {
  name: "aide_uptime_monitors",
  description:
    "外形監視（Uptime Kuma / UptimeRobot）の状況を返す。監視対象の数、停止しているものの名前、" +
    "確認中の件数を含む。" +
    "「サイトは落ちていないか」「外形監視で止まっているものはあるか」" +
    "「監視は何件あるか」を尋ねられたときに呼ぶ。" +
    "一時停止中・メンテナンス中のものは意図して止めているため数に入れていない。" +
    "monitors が null なら監視の情報そのものを取得できておらず、**停止が無いという意味ではない**。" +
    "**ホストのCPU・メモリ・ディスクは aide_host_status、各サービスの残枠は aide_service_quotas。**",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async () => {
    const status = await buildOpsStatus();
    return json({ ...section(status, "monitors", status.monitors !== null), monitors: status.monitors });
  },
};

export const serviceQuotasTool: Tool = {
  name: "aide_service_quotas",
  description:
    "AI・GitHub Actions・1Password の残枠を返す。枠ごとの残り割合（remainingPercent）と" +
    "リセット時刻（resetsAt。分からなければ null）を含む。" +
    "「残枠はどれくらいか」「GitHub Actions の無料枠はあとどれくらいか」" +
    "「1Passwordの上限に近づいていないか」を尋ねられたときに呼ぶ。" +
    "problems には残りが少ない枠だけが入る（35%以下で warn、15%以下で danger）。" +
    "quotas が空なら残枠の情報を取得できておらず、**枠が無い・余裕があるという意味ではない**" +
    "（理由は unavailable に入る）。" +
    "**ホストのCPU・メモリ・ディスクは aide_host_status、外形監視は aide_uptime_monitors。**",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async () => {
    const status = await buildOpsStatus();
    return json({ ...section(status, "quotas", status.quotas.length > 0), quotas: status.quotas });
  },
};
