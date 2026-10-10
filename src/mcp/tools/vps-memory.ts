import { fetchDevelopmentSummary } from "../../core/connectors/issue-deck/development-summary.ts";
import type { SummaryQuery } from "../../core/connectors/issue-deck/development-summary.ts";
import { readVpsMemoryConfig, VPS_MEMORY_PATH } from "../../core/connectors/issue-deck/vps-memory.ts";
import type { Tool, ToolResult } from "../types.ts";

/**
 * 本番 issue-deck のVPSメモリ計測結果の読み取り（#608）。
 *
 * **計測・集計は issue-deck 側の責務で、AIDEは中継するだけ**（区間の合算・欠測の補完をしない）。
 * 読み取り専用で、VPSへの接続・再起動・計測の起動は行わない。
 */

function json(payload: unknown): ToolResult {
  // 未設定・取得失敗は「エラー」ではなく状態。isErrorにするとClaudeが再試行して無駄になる。
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError: false };
}

const NOT_CONFIGURED = {
  status: "not_configured",
  reason: "VPSメモリ計測の取得が未設定です（AIDE_ISSUE_DECK_URL と、issue-deck の共有トークン ISSUE_DECK_VPS_MEMORY_TOKEN が要ります）。メモリ使用量は不明で、0MBではありません。",
};

const MIN_HOURS = 1;
const MAX_HOURS = 168;

/** 引数の検査。通れば issue-deck へ渡すクエリ、通らなければ利用者へ返せる理由。 */
export function buildVpsMemoryQuery(args: Record<string, unknown>): SummaryQuery | string {
  const query: SummaryQuery = {};

  const hours = args["hours"];
  if (hours !== undefined) {
    if (typeof hours !== "number" || !Number.isInteger(hours) || hours < MIN_HOURS || hours > MAX_HOURS) {
      return `hours は${MIN_HOURS}〜${MAX_HOURS}の整数で指定してください`;
    }
    query["hours"] = hours;
  }

  const history = args["history"];
  if (history !== undefined) {
    if (typeof history !== "boolean") return "history は true / false で指定してください";
    if (history) query["history"] = 1;
  }
  return query;
}

export const vpsMemoryTool: Tool = {
  name: "aide_vps_memory",
  description:
    "本番VPS上の issue-deck（next-server）の**メモリ計測結果を返す。読み取り専用**で、VPSへの接続・計測の起動・再起動はしない。" +
    "「issue-deckのメモリは今どれくらい？」「増え続けていない？」「再起動で下がった？」に使う。" +
    "最新サンプル（RSS・VmHWM・スレッド数・ホストの空き・Swap）・最後に取得できた時刻・プロセス区間ごとの観測最大を、issue-deckの応答のまま返す（AIDEでは再集計しない）。" +
    "**取得不可を0MBと読まないこと。** `latest.status` が `unavailable` なら `reason` を、`lastSuccessAt` と `latestAgeSeconds`（最新サンプルからの経過秒）を必ず確かめる。" +
    "計測はサブPCから手動起動で、常時実行ではない。`latestAgeSeconds` が大きいときは古い値で、現在値ではない。" +
    "`segments` はPID・起動時刻ごとの別プロセス（デプロイ・再起動で別区間になる）で、混ぜて1つの推移として読まないこと。" +
    "採取サンプルの推移が要るときだけ `history: true` を付ける（応答が大きくなる）。",
  inputSchema: {
    type: "object",
    properties: {
      hours: {
        type: "integer",
        minimum: MIN_HOURS,
        maximum: MAX_HOURS,
        description: `遡る時間（${MIN_HOURS}〜${MAX_HOURS}時間）。省略時は24時間。`,
      },
      history: {
        type: "boolean",
        description: "true で採取サンプルの履歴も返す。省略時は最新・区間の要約だけ。",
      },
    },
    additionalProperties: false,
  },
  handler: async (args) => {
    const query = buildVpsMemoryQuery(args);
    if (typeof query === "string") return json({ status: "invalid_arguments", reason: query });

    const config = await readVpsMemoryConfig();
    if (!config) return json(NOT_CONFIGURED);

    const outcome = await fetchDevelopmentSummary(config, VPS_MEMORY_PATH, query);
    if (outcome.status !== "ok") {
      return json({
        status: outcome.status,
        httpStatus: outcome.httpStatus,
        reason: outcome.reason,
        note: "取得できていないためメモリ使用量は不明です（0MB・問題なしではありません）。",
      });
    }
    // issue-deckの応答は加工せず、そのまま `data` に入れる（latest・lastSuccessAt・latestAgeSeconds・segments を含む）。
    return json({ status: "ok", data: outcome.data });
  },
};
