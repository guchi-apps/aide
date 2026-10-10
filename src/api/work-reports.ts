import type { IncomingMessage, ServerResponse } from "node:http";
import { workReportStore, type WorkReportStore } from "../core/work-reports/store.ts";
import { LIMITS } from "../core/work-reports/types.ts";
import { bearerToken, secretMatches } from "./secret.ts";

/**
 * `GET /api/work-reports`（#609）。StatusHubが保存済みの作業報告を読む口。MCPの `aide_work_reports`
 * と同じ正本（`core/work-reports/store.ts`）を返す。**読み取り専用**で書込みは持たない。
 *
 * 認証は専用の共有シークレット `AIDE_WORK_REPORTS_READ_SECRET`。残高を読む `AIDE_READ_SECRET` や
 * 動作状況の `AIDE_STATUS_SECRET` とは別の値にする（読める範囲を混ぜない）。
 * 未設定は503、値違いは401（切り分けのため分ける）。取得失敗は503で、空の一覧（200）と区別する。
 */

function json(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res
    .writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra })
    .end(JSON.stringify(body));
}

export async function handleWorkReports(
  req: IncomingMessage,
  res: ServerResponse,
  store: WorkReportStore = workReportStore(),
  secret: string | null = process.env["AIDE_WORK_REPORTS_READ_SECRET"] || null,
): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    json(res, 405, { error: "method not allowed" }, { Allow: "GET, HEAD" });
    return;
  }
  if (!secret) {
    json(res, 503, { error: "AIDE_WORK_REPORTS_READ_SECRET が未設定のため利用できません" });
    return;
  }
  const presented = bearerToken(req);
  if (!presented || !secretMatches(presented, secret)) {
    console.warn("[work-reports] 認証失敗: GET /api/work-reports");
    json(res, 401, { error: "unauthorized" });
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const workId = url.searchParams.get("workId") ?? undefined;
  const rawLimit = url.searchParams.get("limit");
  let limit: number | undefined;
  if (rawLimit !== null) {
    limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.listMax) {
      json(res, 400, { error: `limit は1以上${LIMITS.listMax}以下の整数で指定してください` });
      return;
    }
  }
  if (workId !== undefined && (!workId || workId.length > LIMITS.idLength)) {
    json(res, 400, { error: "workId が不正です" });
    return;
  }

  try {
    json(res, 200, await store.list({ ...(limit !== undefined ? { limit } : {}), ...(workId !== undefined ? { workId } : {}) }));
  } catch {
    json(res, 503, { error: "read_failed", reason: "保存済みの作業報告を読めませんでした（空の一覧ではなく取得失敗）" });
  }
}
