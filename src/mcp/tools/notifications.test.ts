import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createNotificationTool, createTaskCandidateTool, saveDailyBriefTool } from "./notifications.ts";

describe("ChatGPTスケジュール向け通知登録ツール", () => {
  it("3つのツール名を公開する", () => {
    assert.deepEqual(
      [createNotificationTool, createTaskCandidateTool, saveDailyBriefTool].map((tool) => tool.name),
      ["aide_create_notification", "aide_create_task_candidate", "aide_save_daily_brief"],
    );
  });

  it("メールアドレスを引数に要求せず、必要な項目を必須にする", () => {
    assert.deepEqual(createNotificationTool.inputSchema.required, ["title", "summary", "source", "dedupeKey"]);
    assert.equal(createNotificationTool.inputSchema.additionalProperties, false);
    assert.equal(JSON.stringify(createNotificationTool.inputSchema).includes("email"), false);
  });
});
