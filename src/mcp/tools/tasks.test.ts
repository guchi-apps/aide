import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { completeTaskTool, createTaskTool, listTasksTool, updateTaskTool } from "./tasks.ts";

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

  it("更新は古い読取結果を使わないためversionを必須にする", () => {
    assert.deepEqual(updateTaskTool.inputSchema["required"], ["taskId", "version"]);
    assert.match(updateTaskTool.description, /409 conflict/);
  });
});
