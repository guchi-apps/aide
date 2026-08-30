/**
 * aide-bot のお知らせ登録コネクタ。
 *
 * ChatGPT のスケジュールから受け取った内容を aide-bot の共通登録APIへ渡す。
 * 利用者のメールアドレスはMCPの引数ではなく、AIDEサーバーの設定から決める。
 */

export type AideBotNoticeKind = "schedule" | "task" | "daily-brief";
export type AideBotPriority = "LOW" | "NORMAL" | "URGENT";

export interface AideBotNoticeInput {
  kind: AideBotNoticeKind;
  title: string;
  summary: string;
  source: string;
  dedupeKey: string;
  priority: AideBotPriority;
  url: string | null;
  recommendedAction: string;
  showAt: string | null;
  expiresAt: string | null;
}

interface AideBotConfig {
  url: string;
  token: string;
  email: string;
}

export type AideBotNoticeOutcome =
  | { ok: true; accepted: true; id: string | number | null; kind: AideBotNoticeKind }
  | { ok: false; reason: string };

const LIMITS = {
  title: 120,
  summary: 8_000,
  source: 40,
  dedupeKey: 120,
  recommendedAction: 2_000,
  url: 500,
} as const;

const REQUEST_TIMEOUT_MS = 10_000;

export function readAideBotConfig(env: NodeJS.ProcessEnv = process.env): AideBotConfig | null {
  const url = (env["AIDE_BOT_URL"] ?? "").trim().replace(/\/$/, "");
  const token = (env["AIDE_BOT_TOKEN"] ?? "").trim();
  const email = (env["AIDE_BOT_EMAIL"] ?? "").trim();
  if (!url || !token || !email) return null;

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return { url, token, email };
}

function requiredString(value: unknown, name: string, max: number): string | null {
  if (typeof value !== "string") return `${name} が必要です`;
  const trimmed = value.trim();
  if (!trimmed) return `${name} が必要です`;
  if (trimmed.length > max) return `${name} は ${max} 文字以内で指定してください`;
  return null;
}

function optionalString(value: unknown, name: string, max: number): string | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return undefined;
  return trimmed;
}

function isoDate(value: unknown, name: string): string | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

export function validateNoticeInput(input: AideBotNoticeInput): string | null {
  for (const [value, name, max] of [
    [input.title, "title", LIMITS.title],
    [input.summary, "summary", LIMITS.summary],
    [input.source, "source", LIMITS.source],
    [input.dedupeKey, "dedupeKey", LIMITS.dedupeKey],
  ] as const) {
    const error = requiredString(value, name, max);
    if (error) return error;
  }
  if (!(["LOW", "NORMAL", "URGENT"] as string[]).includes(input.priority)) {
    return "priority は LOW、NORMAL、URGENT のいずれかで指定してください";
  }
  if (input.url !== null && (typeof input.url !== "string" || input.url.length > LIMITS.url)) {
    return `url は ${LIMITS.url} 文字以内で指定してください`;
  }
  if (input.recommendedAction.length > LIMITS.recommendedAction) {
    return `recommendedAction は ${LIMITS.recommendedAction} 文字以内で指定してください`;
  }
  for (const [value, name] of [[input.showAt, "showAt"], [input.expiresAt, "expiresAt"]] as const) {
    if (value !== null && Number.isNaN(new Date(value).getTime())) return `${name} はISO 8601形式で指定してください`;
  }
  return null;
}

export function normalizeNoticeInput(args: Record<string, unknown>, kind: AideBotNoticeKind):
  | { ok: true; input: AideBotNoticeInput }
  | { ok: false; reason: string } {
  const title = typeof args["title"] === "string" ? args["title"].trim() : "";
  const summary = typeof args["summary"] === "string" ? args["summary"].trim() : "";
  const source = typeof args["source"] === "string" ? args["source"].trim() : "";
  const dedupeKey = typeof args["dedupeKey"] === "string" ? args["dedupeKey"].trim() : "";
  const recommendedAction = typeof args["recommendedAction"] === "string" ? args["recommendedAction"].trim() : "";
  const priority = args["priority"] === undefined ? "NORMAL" : args["priority"];
  const url = optionalString(args["url"], "url", LIMITS.url);
  const showAt = isoDate(args["showAt"], "showAt");
  const expiresAt = isoDate(args["expiresAt"], "expiresAt");

  if (url === undefined) return { ok: false, reason: `url は ${LIMITS.url} 文字以内で指定してください` };
  if (showAt === undefined) return { ok: false, reason: "showAt はISO 8601形式で指定してください" };
  if (expiresAt === undefined) return { ok: false, reason: "expiresAt はISO 8601形式で指定してください" };
  if (typeof priority !== "string" || !(["LOW", "NORMAL", "URGENT"] as string[]).includes(priority)) {
    return { ok: false, reason: "priority は LOW、NORMAL、URGENT のいずれかで指定してください" };
  }

  const input: AideBotNoticeInput = {
    kind,
    title,
    summary,
    source,
    dedupeKey,
    priority: priority as AideBotPriority,
    url,
    recommendedAction,
    showAt,
    expiresAt,
  };
  const error = validateNoticeInput(input);
  return error ? { ok: false, reason: error } : { ok: true, input };
}

export async function createAideBotNotice(
  input: AideBotNoticeInput,
  config = readAideBotConfig(),
  fetchImpl: typeof fetch = fetch,
): Promise<AideBotNoticeOutcome> {
  if (!config) return { ok: false, reason: "未設定（AIDE_BOT_URL、AIDE_BOT_TOKEN、AIDE_BOT_EMAIL が揃っていません）" };
  const validationError = validateNoticeInput(input);
  if (validationError) return { ok: false, reason: validationError };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${config.url}/api/notices`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: config.email,
        source: input.source,
        kind: input.kind,
        dedupeKey: input.dedupeKey,
        title: input.title,
        body: [input.summary, input.recommendedAction ? `推奨アクション: ${input.recommendedAction}` : ""]
          .filter(Boolean)
          .join("\n"),
        priority: input.priority,
        url: input.url,
        showAt: input.showAt,
        expiresAt: input.expiresAt,
      }),
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, reason: `aide-botへの登録に失敗しました（HTTP ${response.status}）` };

    let result: unknown = null;
    try {
      result = await response.json();
    } catch {
      // 成功ステータスで本文がJSONでなくても、登録自体は成功として扱う。
    }
    const record = result && typeof result === "object" ? result as Record<string, unknown> : {};
    return {
      ok: true,
      accepted: true,
      id: typeof record["id"] === "string" || typeof record["id"] === "number" ? record["id"] : null,
      kind: input.kind,
    };
  } catch (cause) {
    const reason = cause instanceof DOMException && cause.name === "AbortError"
      ? "aide-botへの登録がタイムアウトしました"
      : "aide-botへ接続できませんでした";
    return { ok: false, reason };
  } finally {
    clearTimeout(timeout);
  }
}
