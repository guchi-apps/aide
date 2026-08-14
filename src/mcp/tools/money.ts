import { buildMoneySummary } from "../../core/views/money.ts";
import type { Tool } from "../types.ts";

/**
 * お金まわりの横断ビュー。
 *
 * AIDEがMCP層に出すのは「横断ビュー」と「公式MCPが無いもの」に限る。
 * Zaimは公式MCPもAPIも無いため、まさにここに該当する。
 */
export const moneySummaryTool: Tool = {
  name: "aide_money_summary",
  description:
    "資産・残高の現況を返す。銀行・電子マネー等の残高一覧と、証券口座ごとの保有銘柄（評価額つき）を含む。" +
    "「いくら持っているか」「どの口座にいくらあるか」「保有銘柄は何か」を尋ねられたときに呼ぶ。" +
    "返す値はキャッシュで、取得時刻と経過時間を併せて返すので、鮮度は呼び出し側で判断すること。",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async () => {
    const summary = await buildMoneySummary();
    return {
      content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      // 未取得は「エラー」ではなく状態。isErrorにするとClaudeが再試行を試みて無駄になる。
      isError: false,
    };
  },
};
