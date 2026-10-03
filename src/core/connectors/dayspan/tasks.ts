import { getSharedToken } from "../issue-deck/shared-tokens.ts";
import { DEFAULT_BASE_URL, TIMEOUT_MS } from "./index.ts";

/** YoteiFlow（DaySpan）のタスク専用内部API契約。正本は dayspan の docs/internal-api.md。 */
export type TaskStatus = "open" | "completed" | "skipped";
export type TaskDateField = "due" | "planned" | "none";

export interface TaskRecord {
  id: string;
  title: string;
  status: TaskStatus;
  due: string | null;
  planned: string | null;
  progress: number | null;
  priority: string | null;
  tags: string[];
  memo: string | null;
  recurrence: string | null;
  version: string;
}

export interface TaskListResponse {
  tasks: TaskRecord[];
  nextCursor: string | null;
  hasMore: boolean;
  generatedAt: string;
  source: { notionReady: boolean; status?: string };
}

export interface TaskConfig {
  baseUrl: string;
  token: string;
  targetEmail: string;
}

export interface TaskWriteConfig extends TaskConfig {}

export async function readTaskConfig(): Promise<TaskConfig | null> {
  const shared = await getSharedToken("DAYSPAN_INTERNAL_API_KEY", "aide");
  const token = shared || process.env["AIDE_DAYSPAN_TOKEN"];
  const targetEmail = process.env["AIDE_DAYSPAN_TARGET_EMAIL"];
  if (!token || !targetEmail) return null;
  return { baseUrl: (process.env["AIDE_DAYSPAN_URL"] ?? DEFAULT_BASE_URL).replace(/\/+$/, ""), token, targetEmail };
}

export async function readTaskWriteConfig(): Promise<TaskWriteConfig | null> {
  const shared = await getSharedToken("DAYSPAN_INTERNAL_TASKS_API_KEY", "aide");
  const token = shared || process.env["AIDE_DAYSPAN_TASKS_WRITE_TOKEN"];
  const targetEmail = process.env["AIDE_DAYSPAN_TARGET_EMAIL"];
  if (!token || !targetEmail) return null;
  return { baseUrl: (process.env["AIDE_DAYSPAN_URL"] ?? DEFAULT_BASE_URL).replace(/\/+$/, ""), token, targetEmail };
}

export type TaskApiResult = { ok: true; body: unknown } | { ok: false; kind: "unauthorized" | "invalid" | "not_found" | "conflict" | "unavailable" | "unknown"; reason: string; body?: unknown };

function headers(config: TaskConfig, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${config.token}`, "x-target-email": config.targetEmail, accept: "application/json", ...extra };
}

async function call(config: TaskConfig, path: string, init: RequestInit = {}): Promise<TaskApiResult> {
  try {
    const res = await fetch(`${config.baseUrl}${path}`, { ...init, headers: headers(config, init.headers as Record<string, string>), signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body: unknown = await res.json().catch(() => null);
    if (res.ok) return { ok: true, body };
    const kind = res.status === 400 ? "invalid" : res.status === 401 ? "unauthorized" : res.status === 404 ? "not_found" : res.status === 409 ? "conflict" : res.status === 503 ? "unavailable" : "unknown";
    return { ok: false, kind, reason: `HTTP ${res.status}`, ...(body === null ? {} : { body }) };
  } catch (cause) {
    const reason = cause instanceof Error && cause.name === "TimeoutError" ? `${TIMEOUT_MS}ms 以内に応答しなかった` : "接続できなかった";
    return { ok: false, kind: "unknown", reason };
  }
}

export function listTasks(config: TaskConfig, query: Record<string, string>): Promise<TaskApiResult> {
  const params = new URLSearchParams(query);
  return call(config, `/api/internal/tasks?${params}`);
}

export function getTask(config: TaskConfig, taskId: string): Promise<TaskApiResult> {
  return call(config, `/api/internal/tasks/${encodeURIComponent(taskId)}`);
}

export function createTask(config: TaskWriteConfig, body: Record<string, unknown>, idempotencyKey: string): Promise<TaskApiResult> {
  return call(config, "/api/internal/tasks", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": idempotencyKey }, body: JSON.stringify(body) });
}

export function updateTask(config: TaskWriteConfig, taskId: string, body: Record<string, unknown>): Promise<TaskApiResult> {
  return call(config, `/api/internal/tasks/${encodeURIComponent(taskId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

export function taskAction(config: TaskWriteConfig, taskId: string, action: "complete" | "reopen" | "skip" | "unskip", version: string, idempotencyKey: string): Promise<TaskApiResult> {
  return call(config, `/api/internal/tasks/${encodeURIComponent(taskId)}/actions`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": idempotencyKey }, body: JSON.stringify({ action, version }) });
}
