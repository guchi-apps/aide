import {
  importWeeklyReport,
  normalizeWeeklyReportInput,
  MAX_ARTICLES,
  MAX_ARTICLES_PER_BUSINESS,
  RESEARCH_DESK_INFORMATION_TYPES,
} from "../../core/connectors/research-desk/index.ts";
import type { Tool, ToolResult } from "../types.ts";

const articleSchema = {
  type: "object",
  additionalProperties: false,
  required: ["business", "informationType", "title", "url", "sourceName"],
  properties: {
    business: { type: "string", enum: ["DELIVERY", "LOCKER"], description: "DELIVERY=宅配事業、LOCKER=ロッカー事業" },
    informationType: { type: "string", enum: [...RESEARCH_DESK_INFORMATION_TYPES], description: "情報の種別" },
    title: { type: "string", description: "記事の見出し" },
    url: { type: "string", format: "uri", description: "記事のURL。重複判定に使うため元記事のURLを渡す" },
    sourceName: { type: "string", description: "情報源の名称（媒体名）" },
    publisher: { type: ["string", "null"], description: "発表元の企業・団体" },
    isPrimarySource: { type: "boolean", description: "一次情報（公式発表など）かどうか" },
    publishedAt: { type: ["string", "null"], format: "date-time", description: "公開日時（ISO 8601）" },
    occurredAt: { type: ["string", "null"], format: "date-time", description: "事象の発生日時（ISO 8601）" },
    summary: { type: ["string", "null"], description: "要約" },
    content: { type: ["string", "null"], description: "本文の抜粋" },
    implications: { type: ["string", "null"], description: "商品企画・全体設計への示唆" },
    importance: { type: "string", enum: ["HIGH", "MEDIUM", "REFERENCE"], description: "重要度" },
    targetCompany: { type: ["string", "null"], description: "対象の企業" },
    targetProduct: { type: ["string", "null"], description: "対象の製品・サービス" },
    keywords: { type: "array", items: { type: "string" }, description: "キーワード" },
    tags: { type: "array", items: { type: "string" }, description: "タグ" },
    periodScope: {
      type: "string",
      enum: ["IN_SCOPE", "PAST_30_DAYS_SUPPLEMENT"],
      description: "IN_SCOPE=対象期間内、PAST_30_DAYS_SUPPLEMENT=直近7日で足りず30日まで広げた補足",
    },
  },
};

function output(payload: unknown): ToolResult {
  // Research Desk の status（SUCCEEDED / PARTIAL / FAILED）は業務上の結果であり、
  // MCPの通信エラーではない。Asset Manager の取込ツールと同じ扱いにする。
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError: false };
}

export const researchDeskImportWeeklyReportTool: Tool = {
  name: "aide_research_desk_import_weekly_report",
  description:
    "ChatGPTが検索・選定・要約した宅配事業（DELIVERY）・ロッカー事業（LOCKER）の週次業界情報を、" +
    "Research Deskへ登録します。**明示的に週報の登録を依頼されたときだけ呼ぶ書き込みツール**" +
    "（登録のみ。この経路から取り消し・修正はできません）。" +
    `記事は全体で1〜${MAX_ARTICLES}件、1事業あたり${MAX_ARTICLES_PER_BUSINESS}件までです。` +
    "重複判定・実行履歴・冪等性はResearch Desk側が持つため、同じ週報を再送しても二重登録されず" +
    "重複件数として返ります。応答にはstatus、runId、insertedCount、duplicateCount、" +
    "事業別のbusinessCounts・duplicateBusinessCounts、errorsが含まれます。" +
    "Research Deskの接続先と認証情報はAIDEサーバー側の設定から決まるため、引数には渡しません。",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["executedAt", "targetFrom", "targetTo", "articles"],
    properties: {
      executedAt: { type: "string", format: "date-time", description: "実行基準日時（ISO 8601。例: 2026-08-30T18:00:00+09:00）" },
      targetFrom: { type: "string", format: "date-time", description: "対象期間の開始日時（ISO 8601）" },
      targetTo: { type: "string", format: "date-time", description: "対象期間の終了日時（ISO 8601）" },
      articles: {
        type: "array",
        minItems: 1,
        maxItems: MAX_ARTICLES,
        items: articleSchema,
        description: `週報に載せる記事。宅配事業・ロッカー事業それぞれ${MAX_ARTICLES_PER_BUSINESS}件まで。`,
      },
    },
  },
  handler: async (args) => {
    const normalized = normalizeWeeklyReportInput(args);
    if (!normalized.ok) return output({ ok: false, status: "INVALID_REQUEST", reason: normalized.reason });

    const outcome = await importWeeklyReport(normalized.input);
    if (!outcome.ok) return output({ ok: false, status: "FAILED", reason: outcome.reason });
    return output({ ok: true, ...outcome.result });
  },
};
