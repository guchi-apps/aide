import { getSharedToken } from "../issue-deck/shared-tokens.ts";
import { DEFAULT_ASSET_MANAGER_URL } from "./index.ts";

/**
 * Asset Manager の給与専用のサーバー間API（asset-manager#791。AIDE側は aide#725）。
 *
 * | Asset Manager のAPI | 用途 |
 * |---|---|
 * | `POST /api/salaries/agent/preview` | PDFを解析して確認情報を返す（保存しない）。同じメールの取込済みも `existing` で返す |
 * | `POST /api/salaries/agent/commit` | 本人の承認後に1件だけ保存する（201 `created` / 200 `already_imported`） |
 * | `GET /api/salaries/agent/:id` | 保存された実レコードの読み戻し |
 *
 * 元メールは `source: { mailbox, messageId }` で渡す。向こうがメールボックス＋Message-IDをハッシュにして同一メールを判定する。
 * 元メールだけで登録の有無を引く口は無く、タイムアウト後は同じPDFでプレビューを引き直して `existing` を見る。
 *
 * **認証は給与専用の共有トークン `ASSET_MANAGER_SALARY_AGENT_SECRET` だけ**で、支出・Zaim向けの
 * `ZAIM_SYNC_SECRET` は使わない。環境変数へのフォールバックも持たない（kurashio の書込トークンと同じ方針）。
 * 取れなければ null を返し、呼び出し側は叩きに行かない。**トークン・PDF・明細の金額は、ログにも例外の文面にも出さない。**
 *
 * 向こうの契約は #791 のリリースに追従する。応答の中身はここでは解釈せず、HTTPの成否と通信の失敗だけを分類する。
 */

export const SALARY_AGENT_TOKEN_NAME = "ASSET_MANAGER_SALARY_AGENT_SECRET";
/** PDFの解析を含むので、通常のAPIより長く待つ。 */
export const SALARY_AGENT_TIMEOUT_MS = 20_000;

export interface SalaryAgentConfig {
  baseUrl: string;
  token: string;
}

export async function readSalaryAgentConfig(): Promise<SalaryAgentConfig | null> {
  const token = await getSharedToken(SALARY_AGENT_TOKEN_NAME, "aide");
  if (!token) return null;
  const baseUrl = process.env["AIDE_ASSET_MANAGER_URL"] || DEFAULT_ASSET_MANAGER_URL;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token };
}

export type SalaryAgentResponse =
  | { kind: "ok"; httpStatus: number; body: unknown }
  /** 2xx以外。業務上の拒否（4xx）も連携の失敗（401・5xx）もここに入る。 */
  | { kind: "http_error"; httpStatus: number; body: unknown }
  /** 応答待ちが切れた。**向こうで保存が済んでいるかは分からない。** */
  | { kind: "timeout" }
  | { kind: "network" };

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // JSONでない本文（5xxのHTMLなど）は読んでも役に立たず、内部の構成が載りうるので捨てる。
    return {};
  }
}

export async function callSalaryAgent(
  config: SalaryAgentConfig,
  path: string,
  request: { method: "GET" | "POST"; body?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<SalaryAgentResponse> {
  const headers: Record<string, string> = { Authorization: `Bearer ${config.token}`, Accept: "application/json" };
  if (request.body !== undefined) headers["Content-Type"] = "application/json";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SALARY_AGENT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${config.baseUrl}${path}`, {
      method: request.method,
      headers,
      ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
      signal: controller.signal,
    });
    const body = await readBody(response);
    return response.ok ? { kind: "ok", httpStatus: response.status, body } : { kind: "http_error", httpStatus: response.status, body };
  } catch (cause) {
    return cause instanceof Error && cause.name === "AbortError" ? { kind: "timeout" } : { kind: "network" };
  } finally {
    clearTimeout(timeout);
  }
}
