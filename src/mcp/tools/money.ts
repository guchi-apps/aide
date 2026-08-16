import { buildMoneySummary } from "../../core/views/money.ts";
import type { Tool } from "../types.ts";

/**
 * お金まわりの横断ビュー。
 *
 * AIDEがMCP層に出すのは「横断ビュー」と「公式MCPが無いもの」に限る。
 * Zaim（残高・保有銘柄）と subscription-lists（月額固定費）を1回に畳んでおり、まさにここに該当する。
 * **情報源が増えてもツールは増やさない。** 既存ツールの中身が厚くなるだけにする（aide#27）。
 */
export const moneySummaryTool: Tool = {
  name: "aide_money_summary",
  description:
    "資産・残高と月額固定費の現況を返す。銀行・電子マネー等の残高一覧、証券口座ごとの保有銘柄（評価額つき）、" +
    "サブスクリプションの月額固定費（通貨別の合計・契約ごとの明細・31日以内の支払予定）を含む。" +
    "「いくら持っているか」「どの口座にいくらあるか」「保有銘柄は何か」に加えて、" +
    "「毎月の固定費はいくらか」「次の支払は何がいつあるか」「今月いくら残るか」を尋ねられたときに呼ぶ。" +
    "残高・保有銘柄はキャッシュで、取得時刻と経過時間を併せて返すので鮮度は呼び出し側で判断すること" +
    "（固定費は呼び出しのたびに取得するため常に最新）。",
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
