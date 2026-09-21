import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { garbageCollectionTool, resolveGarbageDate } from "./garbage.ts";

describe("resolveGarbageDate", () => {
  const now = new Date("2026-09-19T14:30:00Z");

  it("相対日を日本時間の今日から解決する", () => {
    assert.equal(resolveGarbageDate({ offsetDays: 1 }, now), "2026-09-20");
    assert.equal(resolveGarbageDate({ date: "2026-10-01", offsetDays: 2 }, now), "2026-10-03");
  });

  it("不正な日付はDaySpan側へ渡し、読めないoffsetDaysは無視する", () => {
    assert.equal(resolveGarbageDate({ date: "2026-02-30", offsetDays: 1 }, now), "2026-02-30");
    assert.equal(resolveGarbageDate({ offsetDays: "1" }, now), undefined);
  });
});

describe("aide_garbage_collection の宣言", () => {
  it("収集日専用で、予定の問いは aide_schedule へ分けることを説明する", () => {
    assert.match(garbageCollectionTool.description, /aide_schedule/);
    assert.match(garbageCollectionTool.description, /予定・タスク・空き時間は返さない/);
    assert.match(garbageCollectionTool.description, /offsetDays/);
  });

  it("知らない引数を受け付けない", () => {
    assert.equal(garbageCollectionTool.inputSchema["additionalProperties"], false);
  });
});
