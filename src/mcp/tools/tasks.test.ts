import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { completeTaskTool, createTaskTool, listTasksTool, taskDate, updateTaskTool } from "./tasks.ts";

describe("タスク専用MCPツール", () => {
  it("読み取りと書き込みでOAuth scopeを分離する", () => {
    assert.deepEqual(listTasksTool.requiredScopes, ["tasks:read"]);
    for (const tool of [createTaskTool, updateTaskTool, completeTaskTool]) {
      assert.deepEqual(tool.requiredScopes, ["tasks:write"]);
    }
  });

  it("作成は再送用のidempotencyKeyを必須にする", () => {
    assert.deepEqual(createTaskTool.inputSchema["required"], ["title", "idempotencyKey"]);
    assert.match(createTaskTool.description, /同じ値/);
  });

  it("期限・予定日は日付のみとタイムゾーン付きの日時を受け付け、時刻を切り詰めない（#857）", () => {
    for (const value of ["2026-11-20", "2026-11-20T15:00+09:00", "2026-11-20T15:00:00+09:00", "2026-11-20T06:00:00.000Z"]) {
      assert.equal(taskDate(value, "due"), value);
    }
    assert.equal(taskDate(null, "due"), null);
    assert.equal(taskDate(undefined, "due"), undefined);
  });

  it("タイムゾーン無し・実在しない日時・形の違う値は断る（#857）", () => {
    for (const value of ["2026-11-20T15:00", "2026-11-20 15:00+09:00", "2026-02-30T15:00+09:00", "2026-11-20T25:00+09:00", "2026-02-30", 20261120]) {
      const output = taskDate(value, "due");
      assert.ok(output && typeof output === "object", `${value} を断る`);
      assert.match(JSON.parse((output.content[0] as { text: string }).text).reason, /due は/);
    }
  });

  it("作成時に時刻付きの不正な期限はYoteiFlowへ送らずinvalidで返す（#857）", async () => {
    const output = await createTaskTool.handler({ title: "t", idempotencyKey: "k", due: "2026-11-20T15:00" }, { sessionId: null });
    assert.equal(JSON.parse((output.content[0] as { text: string }).text).kind, "invalid");
  });

  it("更新は古い読取結果を使わないためversionを必須にする", () => {
    assert.deepEqual(updateTaskTool.inputSchema["required"], ["taskId", "version"]);
    assert.match(updateTaskTool.description, /409 conflict/);
  });
});
