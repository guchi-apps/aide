/**
 * Research Desk の週報登録コネクタ。
 *
 * ChatGPT が検索・要約した宅配事業／ロッカー事業の週次業界情報を、Research Desk の
 * **AIDE専用内部API** へ中継する（aide#211 / research-desk#31）。
 *
 * ChatGPT は AIDE の接続認証だけを使い、Research Desk のサービス間シークレットは
 * AIDEサーバーの環境変数からしか読まない。引数・応答・ログのどこにも出さない。
 *
 * 冪等性・重複判定・実行履歴は Research Desk 側が持つ。ここでは入力の形だけを検証し、
 * 結果はそのまま素通しする（件数や status を AIDE 側で読み替えない）。
 */

export type ResearchDeskBusiness = "DELIVERY" | "LOCKER";
export type ResearchDeskImportance = "HIGH" | "MEDIUM" | "REFERENCE";
export type ResearchDeskPeriodScope = "IN_SCOPE" | "PAST_30_DAYS_SUPPLEMENT";

/** Research Desk の InformationType。あちらの Prisma enum と同じ並び。 */
export const RESEARCH_DESK_INFORMATION_TYPES = [
  "NEW_PRODUCT",
  "COMPETITOR",
  "INTRODUCTION_CASE",
  "RECRUITMENT_PARTNERSHIP",
  "POLICY_SUBSIDY",
  "MARKET_STATISTICS",
  "USER_ISSUE",
  "CONSTRUCTION",
  "QUALITY_SAFETY",
  "PATENT",
  "OVERSEAS_CASE",
  "OTHER",
] as const;

export type ResearchDeskInformationType = (typeof RESEARCH_DESK_INFORMATION_TYPES)[number];

export interface ResearchDeskArticle {
  business: ResearchDeskBusiness;
  informationType: ResearchDeskInformationType;
  title: string;
  url: string;
  sourceName: string;
  publisher?: string | null;
  isPrimarySource?: boolean;
  publishedAt?: string | null;
  occurredAt?: string | null;
  summary?: string | null;
  content?: string | null;
  implications?: string | null;
  importance?: ResearchDeskImportance;
  targetCompany?: string | null;
  targetProduct?: string | null;
  keywords?: string[];
  tags?: string[];
  periodScope?: ResearchDeskPeriodScope;
}

export interface ResearchDeskWeeklyReportInput {
  executedAt: string;
  targetFrom: string;
  targetTo: string;
  articles: ResearchDeskArticle[];
}

/** Research Desk の `WeeklyReportImportResult` をそのまま受け取るための形。 */
export interface ResearchDeskImportResult {
  runId: string;
  status: "SUCCEEDED" | "PARTIAL" | "FAILED";
  insertedCount: number;
  duplicateCount: number;
  failedCount: number;
  businessCounts: Record<ResearchDeskBusiness, number>;
  duplicateBusinessCounts: Record<ResearchDeskBusiness, number>;
  errors: string[];
  [key: string]: unknown;
}

export type ResearchDeskImportOutcome =
  | { ok: true; result: ResearchDeskImportResult }
  | { ok: false; reason: string };

interface ResearchDeskConfig {
  url: string;
  token: string;
}

/** 1回の週報で送れる記事の上限。全体と1事業あたりの両方を見る（#211）。 */
export const MAX_ARTICLES = 6;
export const MAX_ARTICLES_PER_BUSINESS = 3;

const LIMITS = {
  title: 500,
  sourceName: 500,
  url: 2_048,
  text: 20_000,
  shortText: 500,
  keywords: 30,
  keyword: 100,
} as const;

const REQUEST_TIMEOUT_MS = 15_000;

/** Research Desk 側の受け口。research-desk#31 の推奨API。 */
const IMPORT_PATH = "/api/integrations/aide/weekly-report";

export function readResearchDeskConfig(env: NodeJS.ProcessEnv = process.env): ResearchDeskConfig | null {
  const url = (env["AIDE_RESEARCH_DESK_URL"] ?? "").trim().replace(/\/$/, "");
  const token = (env["AIDE_RESEARCH_DESK_TOKEN"] ?? "").trim();
  if (!url || !token) return null;

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return { url, token };
}

/** ISO 8601として解釈できれば正規化した文字列、できなければ null を返す。 */
function isoDateTime(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function optionalText(value: unknown, name: string, max: number): { value: string | null } | { error: string } {
  if (value === undefined || value === null || value === "") return { value: null };
  if (typeof value !== "string") return { error: `${name} は文字列で指定してください` };
  const trimmed = value.trim();
  if (!trimmed) return { value: null };
  if (trimmed.length > max) return { error: `${name} は ${max} 文字以内で指定してください` };
  return { value: trimmed };
}

function optionalStringArray(value: unknown, name: string): { value: string[] | undefined } | { error: string } {
  if (value === undefined || value === null) return { value: undefined };
  if (!Array.isArray(value)) return { error: `${name} は文字列の配列で指定してください` };
  if (value.length > LIMITS.keywords) return { error: `${name} は ${LIMITS.keywords} 件以内で指定してください` };
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return { error: `${name} は文字列の配列で指定してください` };
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (trimmed.length > LIMITS.keyword) return { error: `${name} の各要素は ${LIMITS.keyword} 文字以内で指定してください` };
    items.push(trimmed);
  }
  return { value: items };
}

function normalizeArticle(value: unknown, index: number):
  | { ok: true; article: ResearchDeskArticle }
  | { ok: false; reason: string } {
  const label = `articles[${index}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: `${label} はオブジェクトで指定してください` };
  }
  const item = value as Record<string, unknown>;

  const business = item["business"];
  if (business !== "DELIVERY" && business !== "LOCKER") {
    return { ok: false, reason: `${label}.business は DELIVERY または LOCKER で指定してください` };
  }

  const informationType = item["informationType"];
  if (typeof informationType !== "string" || !(RESEARCH_DESK_INFORMATION_TYPES as readonly string[]).includes(informationType)) {
    return { ok: false, reason: `${label}.informationType は ${RESEARCH_DESK_INFORMATION_TYPES.join(" / ")} のいずれかで指定してください` };
  }

  const title = typeof item["title"] === "string" ? item["title"].trim() : "";
  if (!title) return { ok: false, reason: `${label}.title は必須です` };
  if (title.length > LIMITS.title) return { ok: false, reason: `${label}.title は ${LIMITS.title} 文字以内で指定してください` };

  const sourceName = typeof item["sourceName"] === "string" ? item["sourceName"].trim() : "";
  if (!sourceName) return { ok: false, reason: `${label}.sourceName は必須です` };
  if (sourceName.length > LIMITS.sourceName) return { ok: false, reason: `${label}.sourceName は ${LIMITS.sourceName} 文字以内で指定してください` };

  const rawUrl = typeof item["url"] === "string" ? item["url"].trim() : "";
  if (!rawUrl) return { ok: false, reason: `${label}.url は必須です` };
  if (rawUrl.length > LIMITS.url) return { ok: false, reason: `${label}.url は ${LIMITS.url} 文字以内で指定してください` };
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, reason: `${label}.url は http または https のURLで指定してください` };
    }
  } catch {
    return { ok: false, reason: `${label}.url が不正です` };
  }

  const article: ResearchDeskArticle = {
    business,
    informationType: informationType as ResearchDeskInformationType,
    title,
    url: rawUrl,
    sourceName,
  };

  for (const [field, max] of [
    ["publisher", LIMITS.shortText],
    ["summary", LIMITS.text],
    ["content", LIMITS.text],
    ["implications", LIMITS.text],
    ["targetCompany", LIMITS.shortText],
    ["targetProduct", LIMITS.shortText],
  ] as const) {
    const parsed = optionalText(item[field], `${label}.${field}`, max);
    if ("error" in parsed) return { ok: false, reason: parsed.error };
    if (parsed.value !== null) article[field] = parsed.value;
  }

  for (const field of ["publishedAt", "occurredAt"] as const) {
    const raw = item[field];
    if (raw === undefined || raw === null || raw === "") continue;
    const parsed = isoDateTime(raw);
    if (!parsed) return { ok: false, reason: `${label}.${field} はISO 8601形式の日時で指定してください` };
    article[field] = parsed;
  }

  if (item["isPrimarySource"] !== undefined) {
    if (typeof item["isPrimarySource"] !== "boolean") {
      return { ok: false, reason: `${label}.isPrimarySource は真偽値で指定してください` };
    }
    article.isPrimarySource = item["isPrimarySource"];
  }

  if (item["importance"] !== undefined) {
    const importance = item["importance"];
    if (importance !== "HIGH" && importance !== "MEDIUM" && importance !== "REFERENCE") {
      return { ok: false, reason: `${label}.importance は HIGH / MEDIUM / REFERENCE のいずれかで指定してください` };
    }
    article.importance = importance;
  }

  if (item["periodScope"] !== undefined) {
    const periodScope = item["periodScope"];
    if (periodScope !== "IN_SCOPE" && periodScope !== "PAST_30_DAYS_SUPPLEMENT") {
      return { ok: false, reason: `${label}.periodScope は IN_SCOPE または PAST_30_DAYS_SUPPLEMENT で指定してください` };
    }
    article.periodScope = periodScope;
  }

  for (const field of ["keywords", "tags"] as const) {
    const parsed = optionalStringArray(item[field], `${label}.${field}`);
    if ("error" in parsed) return { ok: false, reason: parsed.error };
    if (parsed.value !== undefined) article[field] = parsed.value;
  }

  return { ok: true, article };
}

export function normalizeWeeklyReportInput(args: Record<string, unknown>):
  | { ok: true; input: ResearchDeskWeeklyReportInput }
  | { ok: false; reason: string } {
  const executedAt = isoDateTime(args["executedAt"]);
  if (!executedAt) return { ok: false, reason: "executedAt はISO 8601形式の日時で指定してください" };
  const targetFrom = isoDateTime(args["targetFrom"]);
  if (!targetFrom) return { ok: false, reason: "targetFrom はISO 8601形式の日時で指定してください" };
  const targetTo = isoDateTime(args["targetTo"]);
  if (!targetTo) return { ok: false, reason: "targetTo はISO 8601形式の日時で指定してください" };
  if (new Date(targetFrom).getTime() > new Date(targetTo).getTime()) {
    return { ok: false, reason: "targetFrom は targetTo より前の日時で指定してください" };
  }

  const rawArticles = args["articles"];
  if (!Array.isArray(rawArticles) || rawArticles.length === 0) {
    return { ok: false, reason: `articles は1〜${MAX_ARTICLES}件の配列で指定してください` };
  }
  if (rawArticles.length > MAX_ARTICLES) {
    return { ok: false, reason: `articles は${MAX_ARTICLES}件までです` };
  }

  const counts: Record<ResearchDeskBusiness, number> = { DELIVERY: 0, LOCKER: 0 };
  const articles: ResearchDeskArticle[] = [];
  for (const [index, raw] of rawArticles.entries()) {
    const normalized = normalizeArticle(raw, index);
    if (!normalized.ok) return { ok: false, reason: normalized.reason };
    counts[normalized.article.business]++;
    if (counts[normalized.article.business] > MAX_ARTICLES_PER_BUSINESS) {
      return { ok: false, reason: `1事業あたりの記事は${MAX_ARTICLES_PER_BUSINESS}件までです（${normalized.article.business}）` };
    }
    articles.push(normalized.article);
  }

  return { ok: true, input: { executedAt, targetFrom, targetTo, articles } };
}

function toImportResult(payload: unknown): ResearchDeskImportResult | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (typeof record["runId"] !== "string") return null;
  const status = record["status"];
  if (status !== "SUCCEEDED" && status !== "PARTIAL" && status !== "FAILED") return null;
  return record as unknown as ResearchDeskImportResult;
}

/**
 * 週報を Research Desk へ登録する。
 *
 * 通信・HTTPの失敗はここで日本語の理由へ畳み、業務上の結果（重複・部分成功）は
 * Research Desk の応答をそのまま返す。**HTTPの本文や status を理由文へ混ぜない**
 * （認証情報や取得データが漏れる経路になるため）。
 */
export async function importWeeklyReport(
  input: ResearchDeskWeeklyReportInput,
  config = readResearchDeskConfig(),
  fetchImpl: typeof fetch = fetch,
): Promise<ResearchDeskImportOutcome> {
  if (!config) {
    return { ok: false, reason: "未設定（AIDE_RESEARCH_DESK_URL、AIDE_RESEARCH_DESK_TOKEN が揃っていません）" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${config.url}${IMPORT_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(input),
      signal: controller.signal,
    });

    if (!response.ok) {
      return { ok: false, reason: httpReason(response.status) };
    }

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      return { ok: false, reason: "Research Deskの応答を解釈できませんでした" };
    }
    const result = toImportResult(payload);
    if (!result) return { ok: false, reason: "Research Deskの応答に実行結果が含まれていませんでした" };
    return { ok: true, result };
  } catch (cause) {
    const aborted = cause instanceof Error && cause.name === "AbortError";
    return { ok: false, reason: aborted ? "Research Deskへの登録がタイムアウトしました" : "Research Deskへ接続できませんでした" };
  } finally {
    clearTimeout(timeout);
  }
}

function httpReason(status: number): string {
  if (status === 401 || status === 403) return "Research Deskの認証に失敗しました（AIDE側の設定を確認してください）";
  if (status === 400 || status === 422) return "Research Deskが入力を受け付けませんでした（週報の内容を見直してください）";
  if (status === 404) return "Research Deskの登録先が見つかりませんでした（接続先URLを確認してください）";
  if (status === 429) return "Research Deskの呼び出し回数の上限を超えました（しばらく待ってから再実行してください）";
  if (status >= 500) return "Research Desk側でエラーが発生しました（時間をおいて再実行してください）";
  return "Research Deskへの登録に失敗しました";
}
