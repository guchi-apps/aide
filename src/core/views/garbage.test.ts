import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DaySpanSchedule } from "../connectors/dayspan/types.ts";
import { collectGarbage, summarizeGarbage } from "./garbage.ts";

const NOW = new Date("2026-08-25T01:00:00.000Z");

function schedule(overrides: Partial<DaySpanSchedule> = {}): DaySpanSchedule {
  return {
    generatedAt: "2026-08-25T00:59:00.000Z",
    timeZone: "Asia/Tokyo",
    range: { from: "2026-08-25", to: "2026-09-24" },
    sources: { notionReady: true, reminderReady: true },
    days: [
      {
        date: "2026-08-25",
        reminders: [
          { id: "ordinary", title: "普通ごみ", source: "garbage", memo: "生ごみ・紙くずなど" },
          { id: "birthday", title: "誕生日", source: "reminder" },
        ],
      },
      {
        date: "2026-09-01",
        reminders: [{ id: "nonburnable", title: "不燃ごみ", source: "garbage", memo: "第1火曜日" }],
      },
      {
        date: "2026-09-03",
        reminders: [{ id: "ordinary-next", title: "普通ごみ", source: "garbage" }],
      },
    ],
    ...overrides,
  };
}

describe("collectGarbage", () => {
  it("ゴミ収集日だけを日付順で取り出し、注意事項を残す", () => {
    assert.deepEqual(collectGarbage(schedule()), [
      { category: "普通ごみ", date: "2026-08-25", weekday: "火", note: "生ごみ・紙くずなど" },
      { category: "不燃ごみ", date: "2026-09-01", weekday: "火", note: "第1火曜日" },
      { category: "普通ごみ", date: "2026-09-03", weekday: "木", note: null },
    ]);
  });

  it("区分名はmyroomの文字列どおりに完全一致で絞る", () => {
    assert.deepEqual(collectGarbage(schedule(), "不燃ごみ").map((collection) => collection.date), ["2026-09-01"]);
    assert.deepEqual(collectGarbage(schedule(), "燃えないごみ"), []);
  });
});

describe("summarizeGarbage", () => {
  it("指定日の収集と区分ごとの次回収集日を分ける", () => {
    const summary = summarizeGarbage(schedule(), NOW);
    assert.deepEqual(summary.collectionsOnDate.map((collection) => collection.category), ["普通ごみ"]);
    assert.deepEqual(
      summary.nextCollections.map((collection) => [collection.category, collection.date]),
      [
        ["普通ごみ", "2026-08-25"],
        ["不燃ごみ", "2026-09-01"],
      ],
    );
    assert.equal(summary.complete, true);
  });

  it("部分取得失敗は収集なしとして扱わない", () => {
    const summary = summarizeGarbage(schedule({ errors: [{ source: "notion", reason: "取得できませんでした。" }] }), NOW);
    assert.equal(summary.complete, false);
    assert.match(summary.note, /収集が無いという意味ではない/);
    assert.deepEqual(summary.unavailable, [{ source: "notion", reason: "取得できませんでした。" }]);
  });

  it("収集日が無い結果は未設定・未同期の可能性も説明する", () => {
    const summary = summarizeGarbage(schedule({ days: [] }), NOW, "不燃ごみ");
    assert.deepEqual(summary.collectionsOnDate, []);
    assert.deepEqual(summary.nextCollections, []);
    assert.match(summary.note, /設定・同期されていない/);
  });
});
