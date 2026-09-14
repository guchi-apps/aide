import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthConfig } from "../auth/config.ts";
import { resolveBaseUrl } from "../auth/config.ts";
import type { SupabaseAuthConfig } from "../auth/supabase.ts";
import { buildHealth } from "../core/views/health.ts";
import type { ToolRegistry } from "../mcp/registry.ts";
import { runProbes } from "../web/status.ts";
import { bearerToken, secretMatches } from "./secret.ts";

/**
 * ops-dashboard向けの動作状況JSON API（aide#276。起点 guchi-apps/ops-dashboard#237）。
 *
 * `GET /status`（ブラウザ向けのHTMLページ、`src/web/status.ts`）と同じ判定（`buildHealth()`）を、
 * 同じVPS上の ops-dashboard がサーバー間で読める形で出す。ops-dashboard はこれを「AIDE」タブへ
 * 表示する。**`/status` 側の画面はこのIssueでは廃止しない**（ops-dashboardのタブで足りると
 * 確かめてから別Issueで行う）。
 *
 * 認証は共有シークレット1本（`AIDE_STATUS_SECRET`）。**`/api/money/*` の `AIDE_READ_SECRET` とは
 * 別の値にする。** 同じ値にすると、動作状況を見たいだけの ops-dashboard に残高を読む権限まで
 * 渡すことになる。未設定は503、不一致は401（`src/api/read.ts` の `authorize()` と同じ分け方）。
 */

export function statusSecret(): string | null {
  return process.env["AIDE_STATUS_SECRET"] || null;
}

function authorize(req: IncomingMessage, res: ServerResponse, label: string): boolean {
  const expected = statusSecret();
  if (!expected) {
    res
      .writeHead(503, { "Content-Type": "application/json; charset=utf-8" })
      .end(JSON.stringify({ error: "AIDE_STATUS_SECRET が未設定のため利用できません" }));
    return false;
  }

  const presented = bearerToken(req);
  if (!presented || !secretMatches(presented, expected)) {
    console.warn(`[status-api] 認証失敗: ${label}`);
    res
      .writeHead(401, { "Content-Type": "application/json; charset=utf-8" })
      .end(JSON.stringify({ error: "unauthorized" }));
    return false;
  }
  return true;
}

export interface StatusApiOptions {
  authConfig: AuthConfig;
  /** Googleログインの設定。`/status` 画面と同じ入力を `buildHealth()` へ渡すために要る。 */
  supabase: SupabaseAuthConfig | null;
  registry: ToolRegistry;
}

/**
 * `health.server.baseUrl` / `mcpUrl` の組み立てに使う公開URL。
 *
 * ops-dashboard は `http://127.0.0.1:3114` へ直接叩くため、**リクエストのHostからは
 * 公開URLを組み立てられない。** `resolveBaseUrl()` は `AIDE_BASE_URL` が設定されていれば
 * それを最優先するが、ヘッダに依存する経路を残さないよう、ここでは空のヘッダで呼び出し、
 * `AIDE_BASE_URL`（未設定ならローカル開発向けの既定値）だけから組み立てる。
 */
function publicBaseUrl(): string {
  return resolveBaseUrl({});
}

/**
 * `GET /api/status`
 *
 * `{ health, tools }` を返す。`health` は `buildHealth()` の戻り値そのまま
 * （`server` / `jobs` / `cache` / `connectors` / `mcp` / `mcpAccess` / `attention` / `severity` / `checkedAt`）。
 * `tools` はMCP接続カードのチップに使うツール名一覧（`registry.list()`）。
 */
export async function handleStatusApi(
  req: IncomingMessage,
  res: ServerResponse,
  options: StatusApiOptions,
): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res
      .writeHead(405, { "Content-Type": "application/json; charset=utf-8", Allow: "GET, HEAD" })
      .end(JSON.stringify({ error: "method not allowed" }));
    return;
  }

  if (!authorize(req, res, "GET /api/status")) return;

  const health = await buildHealth({
    authEnabled: options.authConfig.enabled,
    supabase: options.supabase,
    baseUrl: publicBaseUrl(),
  });
  const tools = options.registry.list().map((tool) => tool.name);

  res
    .writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
    .end(JSON.stringify({ health, tools }));
}

/**
 * `POST /api/status/checks`
 *
 * `/status/checks`（ブラウザ向け、押されたときだけ外部へ問い合わせる）と同じ `runProbes()` を
 * 走らせ、`{ results }` を返す。
 */
export async function handleStatusApiChecks(
  req: IncomingMessage,
  res: ServerResponse,
  options: StatusApiOptions,
): Promise<void> {
  if (req.method !== "POST") {
    res
      .writeHead(405, { "Content-Type": "application/json; charset=utf-8", Allow: "POST" })
      .end(JSON.stringify({ error: "method not allowed" }));
    return;
  }

  if (!authorize(req, res, "POST /api/status/checks")) return;

  const results = await runProbes({ supabase: options.supabase, baseUrl: publicBaseUrl() });
  res
    .writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
    .end(JSON.stringify({ results }));
}
