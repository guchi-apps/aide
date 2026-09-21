import { buildBalances, loadFixedCosts } from "../../core/views/money.ts";
import type { Tool, ToolResult } from "../types.ts";

/**
 * お金まわりの読み取り（#373）。
 *
 * **「いま何を持っているか」と「毎月いくら出ていくか」で2本に分けている。**
 * 以前は `aide_money_summary` 1本で両方を返していたが、残高だけを尋ねられたときにも
 * サブスク契約の全明細まで返っていた。ストック（残高・保有銘柄）とフロー（月額固定費）は
 * 合計に混ぜられない別物で、問いも別々に立つ（`MoneySummary` のコメントも参照）。
 *
 * 分けたことで、残高だけを聞かれたときに subscription-lists を叩かなくなり、
 * 固定費だけを聞かれたときにZaimのキャッシュを読まなくなる。
 */

function json(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    // 未取得は「エラー」ではなく状態。isErrorにするとClaudeが再試行を試みて無駄になる。
    isError: false,
  };
}

export const balancesTool: Tool = {
  name: "aide_balances",
  description:
    "いま持っているお金を返す。銀行・電子マネー等の残高一覧、証券口座ごとの保有銘柄（評価額つき）、" +
    "連携口座ごとのZaim側の最終更新を含む。" +
    "「いくら持っているか」「どの口座にいくらあるか」「保有銘柄は何か」" +
    "「証券口座の評価額は」を尋ねられたときに呼ぶ。" +
    "**毎月の固定費・サブスクの支払予定は返さない**（それは aide_fixed_costs）。" +
    "balances には証券口座の合計が含まれ、holdings はその内訳にあたるため、**両者を足さないこと**。" +
    "キャッシュを読むだけで、取得時刻（fetchedAt）と経過分数（ageMinutes）を併せて返すので" +
    "鮮度は呼び出し側で判断すること。empty が true ならまだ一度も巡回しておらず、" +
    "**残高がゼロという意味ではない**。",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async () => json(await buildBalances()),
};

export const fixedCostsTool: Tool = {
  name: "aide_fixed_costs",
  description:
    "毎月出ていく固定費（サブスクリプション）を返す。通貨別の月額合計・支払方法別の合計・" +
    "契約ごとの明細（契約状況と支払方法つき）・31日以内の支払予定を含む。" +
    "「毎月の固定費はいくらか」「次の支払は何がいつあるか」「解約予定のサブスクはどれか」" +
    "「どのカードから毎月いくら落ちているか」を尋ねられたときに呼ぶ。" +
    "**残高・保有銘柄は返さない**（それは aide_balances）。" +
    "月額合計は**通貨別で、通貨をまたいで加算していない**。monthlyJpy は円換算の参考値で、" +
    "換算できないものがあれば null になる。呼び出しのたびに取得するため常に最新。" +
    "configured が false なら接続が未設定で、**固定費が無いという意味ではない**。" +
    "取得元は移管前の subscription-lists で、移管後の一覧は asset_manager_subscriptions が返す。",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async () => json(await loadFixedCosts()),
};
