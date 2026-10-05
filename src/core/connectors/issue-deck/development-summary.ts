/**
 * IssueDeck の開発サマリー取得コネクタ（#569。API提供側は guchi-apps/issue-deck#3999）。
 *
 * 「開発全体の状況」「予約待ちの件数」「自分の対応が必要なもの」を、IssueDeck の認証付き
 * 読み取り専用APIから**そのまま中継する**。**AIDEでは再集計・再判定しない**（予約除外・保留・前提待ち・
 * 稼働中の確認待ちの扱いは画面の共通ロジックがIssueDeck側にあり、複製すると件数がずれる）。
 * GitHubラベルからの代替推定や、画面用Cookie APIの呼び出しもしない。
 *
 * - 認証は issue-deck の共有トークンAPI（`ISSUE_DECK_DEVELOPMENT_SUMMARY_TOKEN`）から取得する。
 *   新しい環境変数・デプロイ設定は増やさない（`SHARED_TOKEN_API_SECRET` は配線済み）。値は応答・ログへ出さない。
 * - 取得できなかった理由（未設定・認証失敗・タイムアウト・不正な応答）は `status` で区別して返し、
 *   **0件や「問題なし」へ丸めない**。
 * - エラー本文はIssueDeckの応答をそのまま出さず、HTTPステータスと種別だけに丸める。
 *
 * **APIのパス・クエリ名は issue-deck#3999 の確定までの暫定値**（`SUMMARY_PATH` / `ITEMS_PATH`）。
 * 確定したら、ここだけを直す。
 */

import { getSharedToken } from "./shared-tokens.ts";

export const SUMMARY_PATH = "/api/integrations/aide/development-summary";
export const ITEMS_PATH = "/api/integrations/aide/development-items";

const REQUEST_TIMEOUT_MS = 10_000;
/** 応答の大きさの上限。想定外に巨大な本文でメモリを使わない。 */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface DevelopmentSummaryConfig {
  baseUrl: string;
  token: string;
}

/** どちらかが無ければ null（＝IssueDeckへ送信しない）。戻り値はログ・応答へ出さない。 */
export async function readDevelopmentSummaryConfig(): Promise<DevelopmentSummaryConfig | null> {
  const baseUrl = process.env["AIDE_ISSUE_DECK_URL"];
  const shared = await getSharedToken("ISSUE_DECK_DEVELOPMENT_SUMMARY_TOKEN", "aide");
  if (!baseUrl || !shared) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token: shared };
}

export type SummaryQuery = Record<string, string | number | undefined>;

export type SummaryOutcome =
  | { status: "ok"; data: Record<string, unknown> }
  | {
      status: "unauthorized" | "forbidden" | "bad_request" | "timeout" | "unavailable" | "invalid_response";
      httpStatus: number | null;
      reason: string;
    };

function describeStatus(status: number): SummaryOutcome {
  if (status === 401) {
    return { status: "unauthorized", httpStatus: status, reason: "IssueDeckがHTTP 401を返しました（サービス認証が一致しない、または受け口が未対応）" };
  }
  if (status === 403) {
    return { status: "forbidden", httpStatus: status, reason: "IssueDeckがHTTP 403を返しました（対象利用者・リポジトリの認可が通らない）" };
  }
  if (status === 400 || status === 422) {
    return { status: "bad_request", httpStatus: status, reason: `IssueDeckが引数を受け付けませんでした（HTTP ${status}）` };
  }
  return { status: "unavailable", httpStatus: status, reason: `IssueDeckがHTTP ${status}を返しました` };
}

/**
 * 読み取り専用のGETを1回だけ行う。**認証値はHeaderにだけ載せる。**
 * 再試行はしない（件数照会で IssueDeck の負荷・副作用を増やさないため）。
 */
export async function fetchDevelopmentSummary(
  config: DevelopmentSummaryConfig,
  path: string,
  query: SummaryQuery,
  fetchImpl: typeof fetch = fetch,
): Promise<SummaryOutcome> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const qs = params.toString();

  let response: Response;
  try {
    response = await fetchImpl(`${config.baseUrl}${path}${qs ? `?${qs}` : ""}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${config.token}`, "X-Shared-Token-Consumer": "aide", Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    const name = cause instanceof Error ? cause.name : "Error";
    if (name === "TimeoutError" || name === "AbortError") {
      return { status: "timeout", httpStatus: null, reason: `${REQUEST_TIMEOUT_MS}ms 以内に応答しませんでした` };
    }
    return { status: "unavailable", httpStatus: null, reason: `IssueDeckへ届きませんでした（${name}）` };
  }

  if (!response.ok) return describeStatus(response.status);

  const text = await response.text().catch(() => null);
  if (text === null || text.length > MAX_RESPONSE_BYTES) {
    return { status: "invalid_response", httpStatus: response.status, reason: "IssueDeckの応答を読み取れませんでした（大きすぎる、または途中で切れた）" };
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { status: "invalid_response", httpStatus: response.status, reason: "IssueDeckの応答がJSONとして読めません" };
  }
  // 契約の封筒（schemaVersion）が無い応答は、集計結果として扱わない（0件と取り違えさせない）。
  if (!isRecord(body) || body["schemaVersion"] === undefined || body["schemaVersion"] === null) {
    return { status: "invalid_response", httpStatus: response.status, reason: "IssueDeckの応答に schemaVersion が無く、契約どおりの集計として読めません" };
  }
  return { status: "ok", data: body };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
