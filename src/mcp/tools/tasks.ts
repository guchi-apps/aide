import {
  createTask,
  getTask,
  listTasks,
  readTaskConfig,
  readTaskWriteConfig,
  taskAction,
  updateTask,
} from "../../core/connectors/dayspan/tasks.ts";
import type { Tool, ToolResult } from "../types.ts";

const TASK_READ = ["tasks:read"] as const;
const TASK_WRITE = ["tasks:write"] as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TEXT = 2000;

function result(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError: false };
}

function invalid(reason: string): ToolResult {
  return result({ ok: false, kind: "invalid", reason });
}

/** 成功時はYoteiFlowの業務応答をそのまま返す。二重のbodyでID・状態を埋めない。 */
function apiResult(output: Awaited<ReturnType<typeof listTasks>>): ToolResult {
  return output.ok ? result(output.body) : result(output);
}

function isToolResult(value: unknown): value is ToolResult {
  return typeof value === "object" && value !== null && "content" in value;
}

function string(value: unknown, name: string, required = false): string | undefined | ToolResult {
  if (value === undefined) return required ? invalid(`${name} は必須です`) : undefined;
  if (typeof value !== "string" || !value.trim()) return invalid(`${name} は空でない文字列で指定してください`);
  return value.trim();
}

function idempotencyKey(args: Record<string, unknown>): string | ToolResult {
  const value = string(args["idempotencyKey"], "idempotencyKey", true);
  if (typeof value !== "string") return value as ToolResult;
  if (value.length > 200) return invalid("idempotencyKey は200文字以内で指定してください");
  return value;
}

function version(args: Record<string, unknown>): string | ToolResult {
  return string(args["version"], "version", true) as string | ToolResult;
}

function taskId(args: Record<string, unknown>): string | ToolResult {
  return string(args["taskId"], "taskId", true) as string | ToolResult;
}

function date(value: unknown, name: string): string | null | ToolResult | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || !DAY.test(value)) return invalid(`${name} は YYYY-MM-DD または null で指定してください`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return invalid(`${name} は実在する日付で指定してください`);
  return value;
}

function fields(args: Record<string, unknown>, creating: boolean): Record<string, unknown> | ToolResult {
  const next: Record<string, unknown> = {};
  const title = string(args["title"], "title", creating);
  if (typeof title !== "string" && title !== undefined) return title as ToolResult;
  if (title !== undefined) {
    if (title.length > 300) return invalid("title は300文字以内で指定してください");
    next.title = title;
  }
  for (const name of ["due", "planned"] as const) {
    const value = date(args[name], name);
    if (value && typeof value === "object") return value;
    if (value !== undefined) next[name] = value;
  }
  for (const name of ["memo", "priority", "recurrence"] as const) {
    const value = args[name];
    if (value === undefined) continue;
    if (value !== null && typeof value !== "string") return invalid(`${name} は文字列または null で指定してください`);
    if (typeof value === "string" && value.length > MAX_TEXT) return invalid(`${name} は${MAX_TEXT}文字以内で指定してください`);
    next[name] = typeof value === "string" ? value.trim() || null : null;
  }
  if (args["progress"] !== undefined) {
    const value = args["progress"];
    if (value !== null && (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100)) return invalid("progress は0〜100の整数または null で指定してください");
    next.progress = value;
  }
  if (args["tags"] !== undefined) {
    if (!Array.isArray(args["tags"]) || !(args["tags"] as unknown[]).every((tag) => typeof tag === "string" && tag.trim() && tag.length <= 100)) return invalid("tags は100文字以内の空でない文字列配列で指定してください");
    next.tags = (args["tags"] as string[]).map((tag) => tag.trim());
  }
  if (!creating && Object.keys(next).length === 0) return invalid("変更する許可項目を1つ以上指定してください");
  return next;
}

const fieldProperties = {
  title: { type: "string", description: "タスク名。" }, due: { type: ["string", "null"], description: "期限（YYYY-MM-DD）。nullで解除。" }, planned: { type: ["string", "null"], description: "予定日（YYYY-MM-DD）。nullで解除。" }, priority: { type: ["string", "null"], description: "優先度。nullで解除。" }, memo: { type: ["string", "null"], description: "メモ。nullで解除。" }, tags: { type: "array", items: { type: "string" }, description: "タグの全置換。" }, recurrence: { type: ["string", "null"], description: "YoteiFlowが受け付ける繰り返し指定。nullで解除。" }, progress: { type: ["integer", "null"], minimum: 0, maximum: 100, description: "進捗（0〜100）。状態とは別軸。" },
};

export const listTasksTool: Tool = {
  name: "aide_tasks", requiredScopes: TASK_READ,
  description: "固定タスクDBのタスクだけをYoteiFlow経由で一覧取得する読み取りツール。予定・移動は取得しない。status、dateField、期間、未設定日付、limit（最大100）、cursorで絞る。hasMore が true なら nextCursor を同じ条件で再送して続きだけ取得する。source.notionReady が false、空一覧、部分結果は別の状態であり混同しない。正式な作成・更新・状態変更には書き込みツールを使う。",
  inputSchema: { type: "object", properties: { status: { type: "string", enum: ["open", "completed", "skipped"] }, dateField: { type: "string", enum: ["due", "planned", "none"] }, from: { type: "string" }, to: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 }, cursor: { type: "string" } }, additionalProperties: false },
  handler: async (args) => {
    const config = await readTaskConfig();
    if (!config) return result({ ok: false, kind: "unavailable", reason: "未設定（AIDE_DAYSPAN_TOKEN と AIDE_DAYSPAN_TARGET_EMAIL が必要です）" });
    const query: Record<string, string> = {};
    for (const name of ["status", "dateField", "cursor"] as const) if (typeof args[name] === "string") query[name] = args[name];
    for (const name of ["from", "to"] as const) { const value = date(args[name], name); if (value && typeof value === "object") return value; if (typeof value === "string") query[name] = value; }
    if (args["limit"] !== undefined) { if (typeof args["limit"] !== "number" || !Number.isInteger(args["limit"]) || args["limit"] < 1 || args["limit"] > 100) return invalid("limit は1〜100の整数で指定してください"); query.limit = String(args["limit"]); }
    return apiResult(await listTasks(config, query));
  },
};

export const getTaskTool: Tool = {
  name: "aide_get_task", requiredScopes: TASK_READ,
  description: "固定タスクDBの指定タスクの現在状態をYoteiFlow経由で取得する読み取りツール。aide_tasks が返した taskId を使い、更新前には必ず最新の version をここで確認する。",
  inputSchema: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"], additionalProperties: false },
  handler: async (args) => { const id = taskId(args); if (typeof id !== "string") return id; const config = await readTaskConfig(); return !config ? result({ ok: false, kind: "unavailable", reason: "未設定" }) : apiResult(await getTask(config, id)); },
};

export const createTaskTool: Tool = {
  name: "aide_create_task", requiredScopes: TASK_WRITE,
  description: "固定タスクDBへ正式なタスクをYoteiFlow経由で作成する書き込みツール。明示的に「タスクとして作成して」と依頼されたときだけ使う。idempotencyKey は再送時も同じ値を必ず使う。タイムアウトや result_unknown では新しいキーに変えず、同じキーで再照会・再送する。Morrow候補を作る aide_create_task_candidate とは異なる。",
  inputSchema: { type: "object", properties: { ...fieldProperties, idempotencyKey: { type: "string", description: "作成要求を識別するキー。安全な再送時も同じ値を使う。" } }, required: ["title", "idempotencyKey"], additionalProperties: false },
  handler: async (args) => { const key = idempotencyKey(args); if (typeof key !== "string") return key; const body = fields(args, true); if (isToolResult(body)) return body; const config = await readTaskWriteConfig(); return !config ? result({ ok: false, kind: "unavailable", reason: "未設定（AIDE_DAYSPAN_TASKS_WRITE_TOKEN が必要です）" }) : apiResult(await createTask(config, body, key)); },
};

export const updateTaskTool: Tool = {
  name: "aide_update_task", requiredScopes: TASK_WRITE,
  description: "固定タスクDBの許可項目だけをYoteiFlow経由で部分更新する書き込みツール。aide_get_task で直前に得た taskId と version を必ず使う。409 conflict なら再読取して利用者へ差分を確認し、古い値で再送しない。完了・対応しないは状態操作ツールを使う。",
  inputSchema: { type: "object", properties: { taskId: { type: "string" }, version: { type: "string" }, ...fieldProperties }, required: ["taskId", "version"], additionalProperties: false },
  handler: async (args) => { const id = taskId(args); if (typeof id !== "string") return id; const current = version(args); if (typeof current !== "string") return current; const body = fields(args, false); if (isToolResult(body)) return body; const config = await readTaskWriteConfig(); return !config ? result({ ok: false, kind: "unavailable", reason: "未設定" }) : apiResult(await updateTask(config, id, { ...body, version: current })); },
};

function actionTool(name: string, action: "complete" | "reopen" | "skip" | "unskip", description: string): Tool {
  return { name, requiredScopes: TASK_WRITE, description, inputSchema: { type: "object", properties: { taskId: { type: "string" }, version: { type: "string" }, idempotencyKey: { type: "string", description: "安全な再送時も変えない操作キー。" } }, required: ["taskId", "version", "idempotencyKey"], additionalProperties: false }, handler: async (args) => { const id = taskId(args); if (typeof id !== "string") return id; const current = version(args); if (typeof current !== "string") return current; const key = idempotencyKey(args); if (typeof key !== "string") return key; const config = await readTaskWriteConfig(); return !config ? result({ ok: false, kind: "unavailable", reason: "未設定" }) : apiResult(await taskAction(config, id, action, current, key)); } };
}

export const completeTaskTool = actionTool("aide_complete_task", "complete", "固定タスクDBのタスクを完了にする書き込みツール。明示的な完了指示だけで使う。繰り返しタスクの次回分はYoteiFlowが一度だけ作る。安全な再送では同じ idempotencyKey を使う。");
export const reopenTaskTool = actionTool("aide_reopen_task", "reopen", "固定タスクDBの完了タスクを未完了へ戻す書き込みツール。次回タスクは作成も削除もしない。最新 version と同じ idempotencyKey を使う。");
export const skipTaskTool = actionTool("aide_skip_task", "skip", "固定タスクDBのタスクを「対応しない」にする書き込みツール。完了とは意味が異なり、次回タスクは作らない。明示指示と最新 version が必要。");
export const unskipTaskTool = actionTool("aide_unskip_task", "unskip", "固定タスクDBの「対応しない」を解除する書き込みツール。未完了へ戻す操作であり、次回タスクは作らない。明示指示と最新 version が必要。");
