import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthConfig } from "../auth/config.ts";
import { resolveBaseUrl } from "../auth/config.ts";
import { checkRedirectAllowed } from "../auth/redirect-check.ts";
import type { SupabaseAuthConfig } from "../auth/supabase.ts";
import { probeZaimWebUpstream } from "../core/connectors/zaim/web-payment-forward.ts";
import { buildDevStatus } from "../core/views/dev.ts";
import { buildHealth } from "../core/views/health.ts";
import { buildMoneySummary } from "../core/views/money.ts";
import { buildOpsStatus } from "../core/views/ops.ts";
import { buildRoomStatus } from "../core/views/room.ts";
import { buildSchedule } from "../core/views/schedule.ts";
import type { ToolRegistry } from "../mcp/registry.ts";
import { bearerToken, secretMatches } from "./secret.ts";

/**
 * ops-dashboard向けの動作状況JSON API（aide#276。起点 guchi-apps/ops-dashboard#237）。
 *
 * 動作状況の判定（`buildHealth()`）を、同じVPS上の ops-dashboard がサーバー間で読める形で出す。
 * ops-dashboard はこれを「AIDE」タブへ表示する。**動作状況を人が見る場所はそこだけ**で、
 * 以前AIDE自身が持っていたブラウザ向けの画面（`GET /status`）は #328 で外した。
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
  /** Googleログインの設定。`buildHealth()` が接続先の設定状況を判定するために要る。 */
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
 * 押されたときだけ外部の接続先へ問い合わせる `runProbes()`（下）を走らせ、`{ results }` を返す。
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

export interface ProbeResult {
  key: string;
  ok: boolean;
  /** 応答までのミリ秒。 */
  ms: number;
  /** 失敗の理由。外へ出してよい粒度まで丸めたもの（コネクタ側で処理済み）。 */
  detail: string;
}

export interface ProbeOptions {
  /** Googleログインの設定。未設定なら戻り先の確認は行わない。 */
  supabase?: SupabaseAuthConfig | null;
  /** 戻り先を組み立てるための公開URL。 */
  baseUrl?: string;
}

/**
 * 疎通確認。**押されたときだけ走る。**
 *
 * 各コネクタを直接叩かず、MCPツールと同じ横断ビューを通す。ビュー側が失敗理由を
 * 外へ出してよい粒度（HTTPステータスと種別だけ）に丸めているため、URLやトークンが
 * 画面へ漏れる経路を新たに作らずに済む。
 *
 * **Googleログインの戻り先（`supabase-redirect`）だけは横断ビューを持たない。**
 * 畳む先の「外の世界」が無く、確かめたいのはSupabase側の設定とこちらの組み立てが
 * 一致しているかどうかだけなので、`src/auth/redirect-check.ts` を直接呼ぶ。
 */
export async function runProbes(options: ProbeOptions = {}): Promise<ProbeResult[]> {
  const { supabase, baseUrl } = options;
  const measure = async (
    key: string,
    run: () => Promise<{ ok: boolean; detail: string }>,
  ): Promise<ProbeResult> => {
    const startedAt = Date.now();
    try {
      const { ok, detail } = await run();
      return { key, ok, ms: Date.now() - startedAt, detail };
    } catch (cause) {
      return {
        key,
        ok: false,
        ms: Date.now() - startedAt,
        // 例外の message にはURLが載ることがある。種別だけに落とす。
        detail: cause instanceof Error ? cause.name : "取得に失敗した",
      };
    }
  };

  return Promise.all([
    // Googleログインを使っていないときは行そのものが無いので確認しない（readConnectors と対）。
    ...(supabase && baseUrl
      ? [
          measure("supabase-redirect", async () => {
            const result = await checkRedirectAllowed(supabase, baseUrl);
            return { ok: result.status === "ok", detail: result.detail };
          }),
        ]
      : []),
    measure("ops-dashboard", async () => {
      const status = await buildOpsStatus();
      return {
        ok: status.configured && status.complete,
        detail: status.unavailable[0]?.reason ?? (status.configured ? "" : "未設定"),
      };
    }),
    measure("github", async () => {
      const status = await buildDevStatus();
      return {
        ok: status.configured && status.complete,
        detail: status.unavailable[0]?.reason ?? (status.configured ? "" : "未設定"),
      };
    }),
    measure("myroom", async () => {
      const status = await buildRoomStatus();
      return {
        ok: status.configured && status.complete,
        detail: status.unavailable[0]?.reason ?? (status.configured ? "" : "未設定"),
      };
    }),
    measure("dayspan", async () => {
      // 期限切れタスクは取りにいかない（Notionへの往復が1回減る）。疎通の確認に要らない。
      const summary = await buildSchedule({ days: 1, overdueDays: 0 });
      return {
        ok: summary.configured && summary.complete,
        detail: summary.unavailable[0]?.reason ?? (summary.configured ? "" : "未設定"),
      };
    }),
    measure("asset-manager", async () => {
      const summary = await buildMoneySummary();
      return {
        ok: summary.fixedCosts.configured && summary.fixedCosts.unavailable === null,
        detail: summary.fixedCosts.unavailable?.reason ?? (summary.fixedCosts.configured ? "" : "未設定"),
      };
    }),
    // **横断ビューを持たない**（Googleログインの戻り先と同じ）。畳む先の「外の世界」が無く、
    // 確かめたいのは中継先が生きているかどうかだけなので、コネクタを直接叩く（#215）。
    measure("zaim-web-upstream", async () => probeZaimWebUpstream()),
  ]);
}
