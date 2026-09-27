import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { updateEventTool } from "./update-event.ts";
import type { ToolResult } from "../types.ts";

const CTX = { sessionId: null };

function parse(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe("aide_update_event の宣言", () => {
  it("日またぎ予定の終了日を指定できる", () => {
    const properties = updateEventTool.inputSchema["properties"] as Record<string, unknown>;
    assert.ok(properties["endDate"]);
    assert.match(updateEventTool.description, /endDate/);
  });
});

describe("aide_update_event ハンドラ", () => {
  beforeEach(() => {
    delete process.env["AIDE_DAYSPAN_WRITE_TOKEN"];
  });

  it("dryRun で日またぎ変更の正規化後の内容を返し、DaySpanへは送らない", async () => {
    process.env["AIDE_DAYSPAN_WRITE_TOKEN"] = "secret";
    const payload = parse(
      await updateEventTool.handler(
        {
          eventId: "abc123",
          calendarId: "primary",
          date: "2026-09-10",
          endDate: "2026-09-11",
          startTime: "23:00",
          endTime: "01:00",
          dryRun: true,
        },
        CTX,
      ),
    );

    assert.equal(payload["ok"], true);
    assert.equal(payload["dryRun"], true);
    assert.deepEqual(payload["wouldUpdate"], {
      eventId: "abc123",
      calendarId: "primary",
      date: "2026-09-10",
      endDate: "2026-09-11",
      startTime: "23:00",
      endTime: "01:00",
    });
  });
});
