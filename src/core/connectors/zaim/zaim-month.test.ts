import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  coveredCalendarMonths,
  zaimMonthOfDate,
  zaimMonthRange,
  zaimMonthsToRead,
} from "./zaim-month.ts";

describe("Zaimの月（開始日25日）", () => {
  it("24日までは暦月、25日からは翌月のキーになる", () => {
    assert.equal(zaimMonthOfDate("2026-09-24", 25), "202609");
    assert.equal(zaimMonthOfDate("2026-09-25", 25), "202610");
    assert.equal(zaimMonthOfDate("2026-12-31", 25), "202701");
  });

  it("範囲は前月25日〜当月24日（年またぎ含む）", () => {
    assert.deepEqual(zaimMonthRange("202609", 25), { from: "2026-08-25", to: "2026-09-24" });
    assert.deepEqual(zaimMonthRange("202601", 25), { from: "2025-12-25", to: "2026-01-24" });
  });

  it("開始日1日なら暦月そのもの", () => {
    assert.deepEqual(zaimMonthRange("202609", 1), { from: "2026-09-01", to: "2026-09-30" });
  });

  it("読む月は今日を含む月とその前月", () => {
    assert.deepEqual(zaimMonthsToRead("2026-09-24", 25), ["202608", "202609"]);
    assert.deepEqual(zaimMonthsToRead("2026-09-25", 25), ["202609", "202610"]);
  });
});

describe("全日を読めた暦月", () => {
  it("9/25なら 202609・202610 を読み、9月は覆えて8月は覆えない", () => {
    assert.deepEqual(coveredCalendarMonths(["202609", "202610"], "2026-09-25", 25), ["202609", "202610"]);
  });

  it("9/24なら 202608・202609 を読み、8月は覆え、9月は今日以降の分が未来のため覆えたとみなす", () => {
    assert.deepEqual(coveredCalendarMonths(["202608", "202609"], "2026-09-24", 25), ["202608", "202609"]);
  });

  it("月初の範囲の端の月（読み始めの月）は覆えない", () => {
    // 202609 だけなら 8/25〜9/24。8月の1〜24日が無く、9月も25日以降が未来ではない。
    assert.deepEqual(coveredCalendarMonths(["202609"], "2026-10-10", 25), []);
  });

  it("前月の取得に失敗して今日を含む月だけの場合は今日を含む暦月のみ", () => {
    // 9/25〜10/24。10月は1日から今日まで読めているので覆える（9月は1〜24日が無い）。
    assert.deepEqual(coveredCalendarMonths(["202610"], "2026-10-05", 25), ["202610"]);
    assert.deepEqual(coveredCalendarMonths(["202609", "202610"], "2026-10-05", 25), ["202609", "202610"]);
  });
});
