/**
 * Research Desk の週報登録コネクタ。
 *
 * ChatGPT が検索・要約した宅配事業／ロッカー事業の業界情報を、Research Desk の
 * **AIDE専用内部API** へ中継する（aide#211 / research-desk#31）。収集は週1回から
 * 毎日20時へ変わり、Research Desk 側が日曜始まりの週へ集約する（aide#226 / research-desk#43）。
 *
 * ChatGPT は AIDE の接続認証だけを使い、Research Desk のサービス間シークレットは
 * AIDEサーバーの環境変数からしか読まない。引数・応答・ログのどこにも出さない。
 *
 * 冪等性・重複判定・**同一イベントの統合更新**・実行履歴は Research Desk 側が持つ。
 * ここでは入力の形だけを検証し、結果はそのまま素通しする（件数や status を AIDE 側で
 * 読み替えない）。**同一性判定に使う項目（発表主体・対象製品・発表日・主要数値）も、
 * AIDE は形を検証して渡すだけで判定そのものは行わない。**
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
  /** 主要数値（設置台数・金額・稼働率など）。同一イベントへ統合されるとき項目単位でマージされる。 */
  extractedMetrics?: Record<string, unknown>;
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

/**
 * Research Desk の `WeeklyReportImportResult` をそのまま受け取るための形。
 *
 * **必須として扱うのは `runId` と `status` の2つだけ**（`toImportResult` もこの2つしか見ない）。
 * 件数の項目は Research Desk 側の都合で増減しうるため任意にしてあり、増えた項目も
 * インデックスシグネチャでそのまま呼び出し元へ届く。
 */
export interface ResearchDeskImportResult {
  runId: string;
  status: "SUCCEEDED" | "PARTIAL" | "FAILED";
  /** 新規追加された件数。 */
  insertedCount?: number;
  /** 別URLの同一発表として既存記事へ統合・上書き更新された件数（research-desk#43）。 */
  mergedCount?: number;
  /** 同一URL、または内容に変化が無く何もしなかった件数。 */
  duplicateCount?: number;
  /** 週あたりの保持上限を超えて取り込まれなかった・入れ替えられた件数（research-desk#43）。 */
  excludedCount?: number;
  failedCount?: number;
  /** 新規追加＋統合更新の事業別内訳。 */
  businessCounts?: Record<ResearchDeskBusiness, number>;
  duplicateBusinessCounts?: Record<ResearchDeskBusiness, number>;
  errors?: string[];
  [key: string]: unknown;
}

export type ResearchDeskImportOutcome =
  | { ok: true; result: ResearchDeskImportResult }
  | { ok: false; reason: string };

interface ResearchDeskConfig {
  url: string;
  token: string;
}

/**
 * 1回の登録で送れる記事の上限。全体と1事業あたりの両方を見る（#211）。
 *
 * 毎日20時の日次実行で宅配・ロッカーを1回にまとめて送るため、全体6件・1事業3件から広げた（#226）。
 * **Research Desk 側の受け口にも同じ上限がある**ので、あちらを広げるまで10件は400で弾かれる。
 */
export const MAX_ARTICLES = 10;
export const MAX_ARTICLES_PER_BUSINESS = 5;

const LIMITS = {
  title: 500,
  sourceName: 500,
  url: 2_048,
  text: 20_000,
  shortText: 500,
  keywords: 30,
  keyword: 100,
  metrics: 30,
  metricKey: 100,
  /** 主要数値をJSONにしたときの長さ。要約や本文の置き場にされるのを防ぐためだけの値。 */
  metricsJson: 2_000,
} as const;

const REQUEST_TIMEOUT_MS = 15_000;

/** Research Desk 側の受け口（research-desk#31）。あちらの `INTERNAL_API_KEY` と同じ値で認証する。 */
const IMPORT_PATH = "/api/internal/weekly-report";

/** Research Desk が返す説明文をそのまま返すときの上限。あちら側でも200文字に切っている。 */
const MAX_DETAIL_LENGTH = 200;

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

/**
 * 主要数値（`extractedMetrics`）の検証。
 *
 * 中身の意味は Research Desk 側が決める（項目単位でマージして既存記事へ反映する）ため、
 * ここで見るのは**入れ物の形と大きさだけ**。値はMCPのJSONを通ってきた時点でJSONに戻せる
 * ものしか無いので、型の検査はしない。
 */
function optionalMetrics(value: unknown, name: string): { value: Record<string, unknown> | undefined } | { error: string } {
  if (value === undefined || value === null) return { value: undefined };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { error: `${name} は項目名と値を持つオブジェクトで指定してください` };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return { value: undefined };
  if (entries.length > LIMITS.metrics) return { error: `${name} は ${LIMITS.metrics} 項目以内で指定してください` };
  for (const [key] of entries) {
    if (key.length > LIMITS.metricKey) return { error: `${name} の項目名は ${LIMITS.metricKey} 文字以内で指定してください` };
  }
  if (JSON.stringify(value).length > LIMITS.metricsJson) {
    return { error: `${name} が大きすぎます（要約や本文は summary・content へ入れてください）` };
  }
  return { value: value as Record<string, unknown> };
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

  const metrics = optionalMetrics(item["extractedMetrics"], `${label}.extractedMetrics`);
  if ("error" in metrics) return { ok: false, reason: metrics.error };
  if (metrics.value !== undefined) article.extractedMetrics = metrics.value;

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
      return { ok: false, reason: httpReason(response.status, await errorDetail(response)) };
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

/**
 * 失敗応答から説明文だけを取り出す。
 *
 * Research Desk は入力の直し方が分かる `message` を返す設計で、入力本文もシークレットも
 * 載せない（research-desk#31）。**取り出すのはその1フィールドだけ**にし、応答全体は使わない。
 * 認証の失敗だけは何も取り出さない（トークンの取り違えを示す文面を素通ししないため）。
 */
async function errorDetail(response: Response): Promise<string | null> {
  if (response.status === 401 || response.status === 403) return null;
  try {
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const message = (payload as Record<string, unknown>)["message"];
    if (typeof message !== "string") return null;
    const trimmed = message.trim();
    return trimmed ? trimmed.slice(0, MAX_DETAIL_LENGTH) : null;
  } catch {
    return null;
  }
}

function httpReason(status: number, detail: string | null = null): string {
  const base = baseHttpReason(status);
  return detail ? `${base}（Research Desk: ${detail}）` : base;
}

function baseHttpReason(status: number): string {
  if (status === 401 || status === 403) return "Research Deskの認証に失敗しました（AIDE側の設定を確認してください）";
  if (status === 400 || status === 422) return "Research Deskが入力を受け付けませんでした（週報の内容を見直してください）";
  if (status === 404) return "Research Deskの登録先が見つかりませんでした（接続先URLを確認してください）";
  if (status === 429) return "Research Deskの呼び出し回数の上限を超えました（しばらく待ってから再実行してください）";
  if (status >= 500) return "Research Desk側でエラーが発生しました（時間をおいて再実行してください）";
  return "Research Deskへの登録に失敗しました";
}
