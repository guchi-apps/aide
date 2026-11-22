import type { IncomingMessage, ServerResponse } from "node:http";
import {
  type AssignmentState,
  CONTINUITY_GAP_MS,
  FAILBACK_AFTER_MS,
  FAILOVER_AFTER_MS,
  WORKER_HOSTS,
  changeMode,
  claim,
  evaluate,
  isAlive,
  isAssignmentMode,
  isWorkerHost,
  updateAssignment,
} from "../core/worker-assignment.ts";
import { JOB_CATALOG } from "../worker/jobs/catalog.ts";
import { ingestSecret } from "./ingest.ts";
import { bearerToken, secretMatches } from "./secret.ts";
import { statusSecret } from "./status.ts";

/**
 * worker ジョブの担当ホストのAPI（#891）。
 *
 * | 口 | 呼ぶ側 | 認証 |
 * |---|---|---|
 * | `POST /api/worker/claim` | 各ホストの worker（ジョブの実行前） | `AIDE_INGEST_SECRET`（取得結果の送信と同じ） |
 * | `GET /api/worker/assignment` | StatusHub（表示） | `AIDE_STATUS_SECRET` か `AIDE_WORKER_CONTROL_SECRET` |
 * | `POST /api/worker/assignment` | StatusHub（手動の切り替え） | `AIDE_WORKER_CONTROL_SECRET` |
 *
 * **切り替えは読み取りとは別のシークレットにする。** 動作状況を見るだけの側（ops-dashboard）が
 * `AIDE_STATUS_SECRET` を持っているため、それで担当まで変えられると権限が広がりすぎる。
 * worker の `AIDE_INGEST_SECRET` でも切り替えさせない（ホストが自分で担当を奪えないように）。
 */

const MAX_BODY_BYTES = 16 * 1024;

export function workerControlSecret(): string | null {
  return process.env["AIDE_WORKER_CONTROL_SECRET"] || null;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(body));
}

function matchesAny(req: IncomingMessage, secrets: (string | null)[]): boolean {
  const presented = bearerToken(req);
  if (!presented) return false;
  // 全部と照合する（一致した時点で抜けると、どれに一致したかが時間差で漏れる）。
  let ok = false;
  for (const secret of secrets) if (secret && secretMatches(presented, secret)) ok = true;
  return ok;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("payload too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** 画面・MCP・APIに出す形。判定の根拠（各ホストの最終問い合わせ）も一緒に返す。 */
export interface AssignmentView {
  mode: AssignmentState["mode"];
  owner: AssignmentState["owner"];
  hosts: {
    host: string;
    alive: boolean;
    lastSeenAt: string | null;
    aliveSince: string | null;
  }[];
  lastSwitch: AssignmentState["lastSwitch"];
  modeChangedAt: string | null;
  policy: { failoverAfterMinutes: number; failbackAfterMinutes: number; continuityGapMinutes: number };
}

export function toView(state: AssignmentState, now: Date): AssignmentView {
  return {
    mode: state.mode,
    owner: state.owner,
    hosts: WORKER_HOSTS.map((host) => ({
      host,
      alive: isAlive(state, host, now),
      lastSeenAt: state.hosts[host]?.lastSeenAt ?? null,
      aliveSince: state.hosts[host]?.aliveSince ?? null,
    })),
    lastSwitch: state.lastSwitch,
    modeChangedAt: state.modeChangedAt,
    policy: {
      failoverAfterMinutes: FAILOVER_AFTER_MS / 60_000,
      failbackAfterMinutes: FAILBACK_AFTER_MS / 60_000,
      continuityGapMinutes: CONTINUITY_GAP_MS / 60_000,
    },
  };
}

/** 状態を判定し直して返す（読み取りでも、時間の経過で担当が移っていれば保存する）。 */
export function readAssignmentView(now = new Date()): Promise<AssignmentView> {
  return updateAssignment((state) => {
    const next = evaluate(state, now);
    return { state: next, result: toView(next, now) };
  });
}

/** モードを変えて結果を返す。MCPツールとAPIの共通部分。 */
export function setAssignmentMode(mode: AssignmentState["mode"], now = new Date()): Promise<AssignmentView> {
  return updateAssignment((state) => {
    const next = changeMode(state, mode, now);
    return { state: next, result: toView(next, now) };
  });
}

const KNOWN_JOBS = new Set<string>(JOB_CATALOG.map((job) => job.name));

/** `POST /api/worker/claim`。本文は `{ host, job }`。 */
export async function handleWorkerClaim(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
  const expected = ingestSecret();
  if (!expected) return json(res, 503, { error: "AIDE_INGEST_SECRET が未設定のため受け付けられません" });
  if (!matchesAny(req, [expected])) {
    console.warn("[worker-assignment] 認証失敗: claim");
    return json(res, 401, { error: "unauthorized" });
  }

  let body: unknown;
  try {
    body = await readJson(req);
  } catch {
    return json(res, 400, { error: "invalid json" });
  }
  const { host, job } = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (!isWorkerHost(host)) {
    return json(res, 400, { error: `未知のホストです: ${String(host)}（有効: ${WORKER_HOSTS.join(", ")}）` });
  }
  if (typeof job !== "string" || !KNOWN_JOBS.has(job)) {
    return json(res, 400, { error: `未知のジョブです: ${String(job)}` });
  }

  const decision = await updateAssignment((state) => {
    const result = claim(state, host, new Date());
    return { state: result.state, result: result.decision };
  });
  json(res, 200, decision);
}

/** `GET` / `POST /api/worker/assignment`。 */
export async function handleWorkerAssignment(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const control = workerControlSecret();
  if (req.method === "GET" || req.method === "HEAD") {
    const status = await statusSecret();
    if (!status && !control) {
      return json(res, 503, { error: "AIDE_STATUS_SECRET・AIDE_WORKER_CONTROL_SECRET が未設定のため利用できません" });
    }
    if (!matchesAny(req, [status, control])) {
      console.warn("[worker-assignment] 認証失敗: assignment(GET)");
      return json(res, 401, { error: "unauthorized" });
    }
    return json(res, 200, await readAssignmentView());
  }

  if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
  if (!control) return json(res, 503, { error: "AIDE_WORKER_CONTROL_SECRET が未設定のため切り替えられません" });
  if (!matchesAny(req, [control])) {
    console.warn("[worker-assignment] 認証失敗: assignment(POST)");
    return json(res, 401, { error: "unauthorized" });
  }
  let body: unknown;
  try {
    body = await readJson(req);
  } catch {
    return json(res, 400, { error: "invalid json" });
  }
  const mode = (typeof body === "object" && body !== null ? (body as Record<string, unknown>)["mode"] : undefined);
  if (!isAssignmentMode(mode)) {
    return json(res, 400, { error: `mode は auto・${WORKER_HOSTS.join("・")} のいずれかです` });
  }
  const view = await setAssignmentMode(mode);
  console.log(`[worker-assignment] モードを ${mode} にしました（担当 ${view.owner}）`);
  json(res, 200, view);
}
