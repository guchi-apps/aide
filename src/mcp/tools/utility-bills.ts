import {
  buildUtilityBills,
  DEFAULT_MONTHS,
  MAX_MONTHS,
  UTILITY_KINDS,
  type UtilityKind,
} from "../../core/views/utility-bills.ts";
import type { Tool, ToolResult } from "../types.ts";

/**
 * 電気代・ガス代の読み取り（aide#324）。情報源は kurashio の月次請求（aide#714 でZaim公式APIから移した）。
 *
 * `aide_balances` へ畳まず別のツールにしている。あちらは引数を持たない「いまいくら持っているか」で、
 * こちらは種類と期間を指定して「推移」を読む。畳むと毎回13か月ぶんの明細まで載ってしまう。
 */

function json(payload: unknown): ToolResult {
  // 未設定・取得失敗は状態として返す。isError にすると Claude が同じ内容で再試行するだけになる。
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError: false };
}

function parseKinds(value: unknown): readonly UtilityKind[] | string {
  if (value === undefined || value === "all") return UTILITY_KINDS;
  if (typeof value === "string" && (UTILITY_KINDS as readonly string[]).includes(value)) return [value as UtilityKind];
  return "kind は electricity・gas・all のいずれかで指定してください";
}

function parseMonths(value: unknown): number | string {
  if (value === undefined) return DEFAULT_MONTHS;
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_MONTHS) return value;
  return `months は1以上${MAX_MONTHS}以下の整数で指定してください`;
}

export const utilityBillsTool: Tool = {
  name: "aide_utility_bills",
  description:
    "電気代・ガス代の月次請求をkurashioから読み、直近の請求（請求月・金額・使用量）、月ごとの金額と使用量の推移、" +
    "前月・前年同月との比較、期間内の平均額を返す。「今月の電気代」「先月のガス使用量」「最近の電気代の推移」" +
    "「去年より高いか」を尋ねられたときに呼ぶ。使用量（kWh・m3）は請求に書かれていた月だけ入り、無い月は null。" +
    "月は請求月（メールの「◯月分」）で、検針期間・受信日ではない。1件の請求を細かく照会するなら kurashio_get_utility_bill。読み取り専用。",
  inputSchema: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: ["electricity", "gas", "all"],
        description: "electricity（電気）・gas（ガス）・all（両方）。省略時は all。",
      },
      months: {
        type: "integer",
        minimum: 1,
        maximum: MAX_MONTHS,
        description: `今月を含めて何か月ぶんの請求月を遡るか。省略時は${DEFAULT_MONTHS}（前年同月と比べられる長さ）。`,
      },
    },
    additionalProperties: false,
  },
  handler: async (args) => {
    const kinds = parseKinds(args["kind"]);
    if (typeof kinds === "string") return json({ status: "error", reason: kinds });
    const months = parseMonths(args["months"]);
    if (typeof months === "string") return json({ status: "error", reason: months });

    return json(await buildUtilityBills({ kinds, months }));
  },
};
