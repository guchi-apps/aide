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
    informationType: { type: "string", enum: [...RESEARCH_DESK_INFORMATION_TYPES], description: "情報の種別。同一イベント判定にも使われる" },
    title: { type: "string", description: "記事の見出し" },
    url: { type: "string", format: "uri", description: "記事のURL。同一URLの重複判定に使うため元記事のURLを渡す" },
    sourceName: { type: "string", description: "情報源の名称（媒体名）" },
    publisher: {
      type: ["string", "null"],
      description: "発表元の企業・団体。targetCompanyと合わせて発表主体の同一性判定に使われるため、転載記事でも元の発表元を入れる",
    },
    isPrimarySource: { type: "boolean", description: "一次情報（公式発表など）かどうか" },
    publishedAt: { type: ["string", "null"], format: "date-time", description: "公開日時（ISO 8601）" },
    occurredAt: {
      type: ["string", "null"],
      format: "date-time",
      description: "事象の発生日時（ISO 8601）。発表日が近い（5日以内）記事は同一イベントとして統合されうる",
    },
    summary: { type: ["string", "null"], description: "要約" },
    content: { type: ["string", "null"], description: "本文の抜粋" },
    implications: { type: ["string", "null"], description: "商品企画・全体設計への示唆" },
    importance: { type: "string", enum: ["HIGH", "MEDIUM", "REFERENCE"], description: "重要度" },
    targetCompany: { type: ["string", "null"], description: "対象の企業。発表主体の同一性判定に使われる" },
    targetProduct: { type: ["string", "null"], description: "対象の製品・サービス。同一イベント判定の主キーになるため分かる場合は必ず入れる" },
    extractedMetrics: {
      type: "object",
      additionalProperties: true,
      description:
        "主要数値（設置台数・金額・稼働率・対象地域数など）を項目名と値のオブジェクトで。" +
        "例: {\"設置駅数\": 12, \"ボックス数\": 480}。同一イベントへ統合されるとき項目単位でマージされ、" +
        "続報で数値が判明した場合の上書きに使われる。30項目・JSONで2000文字までで、要約や本文は入れない",
    },
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
    "ChatGPTが検索・選定・要約した宅配事業（DELIVERY）・ロッカー事業（LOCKER）の業界情報を、" +
    "Research Deskへ登録します。**明示的に登録を依頼されたときだけ呼ぶ書き込みツール**" +
    "（この経路から取り消し・削除はできません）。" +
    `記事は1回あたり全体で1〜${MAX_ARTICLES}件、1事業あたり${MAX_ARTICLES_PER_BUSINESS}件までです。` +
    "毎日の実行でも構いません（Research Desk側が日曜始まりの週へ集約します）。" +
    "重複判定・同一イベントの統合更新・実行履歴・冪等性はResearch Desk側が持ちます。" +
    "同じ記事を再送しても二重登録されず、URLが違っても発表主体・対象製品・発表日・種別・主要数値から" +
    "同一の発表と判定されたものは新規作成せず既存記事へ統合・上書き更新されます。" +
    "統合させたい記事ほどpublisher・targetCompany・targetProduct・occurredAt・extractedMetricsを埋めてください。" +
    "応答にはstatus、runId、insertedCount（新規）、mergedCount（既存記事への統合更新）、" +
    "duplicateCount（変化なし）、excludedCount（週の上限超過で除外・入れ替え）、failedCount、" +
    "事業別のbusinessCounts（新規＋統合更新）・duplicateBusinessCounts、errorsが含まれます。" +
    "Research Deskの接続先と認証情報はAIDEサーバー側の設定から決まるため、引数には渡しません。",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["executedAt", "targetFrom", "targetTo", "articles"],
    properties: {
      executedAt: { type: "string", format: "date-time", description: "実行基準日時（ISO 8601。例: 2026-09-01T20:00:00+09:00）" },
      targetFrom: { type: "string", format: "date-time", description: "対象期間の開始日時（ISO 8601）。日次実行ならその日を含む直近の範囲でよい" },
      targetTo: { type: "string", format: "date-time", description: "対象期間の終了日時（ISO 8601）" },
      articles: {
        type: "array",
        minItems: 1,
        maxItems: MAX_ARTICLES,
        items: articleSchema,
        description: `登録する記事。宅配事業・ロッカー事業それぞれ${MAX_ARTICLES_PER_BUSINESS}件まで、合計${MAX_ARTICLES}件まで。`,
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
