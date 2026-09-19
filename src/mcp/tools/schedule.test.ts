import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_FREE_WINDOW } from "../../core/views/schedule.ts";
import { readFreeWindow, resolveDate, scheduleTool, shiftDate } from "./schedule.ts";

/**
 * ツール層で確かめるのは**引数の受け取り方**だけ。畳み込みは
 * `src/core/views/schedule.test.ts`、取得はコネクタ側の担当。
 */

describe("readFreeWindow", () => {
  it("指定が無ければ既定の窓を使う", () => {
    assert.deepEqual(readFreeWindow({}), { ...DEFAULT_FREE_WINDOW });
  });

  it("片側だけの指定を受け付ける", () => {
    // 「9時以降で」のような聞き方がそのまま来る。
    assert.deepEqual(readFreeWindow({ freeFrom: "09:00" }), { from: "09:00", to: "22:00" });
    assert.deepEqual(readFreeWindow({ freeTo: "18:00" }), { from: "08:00", to: "18:00" });
  });

  it("読めない値は既定へ倒す", () => {
    assert.deepEqual(readFreeWindow({ freeFrom: "9時", freeTo: 18 }), { ...DEFAULT_FREE_WINDOW });
  });

  it("前後が逆なら丸ごと既定へ戻す", () => {
    // 指定を尊重して空の結果を返すより、既定の窓で答えたほうが問いに近い。
    assert.deepEqual(readFreeWindow({ freeFrom: "22:00", freeTo: "08:00" }), {
      ...DEFAULT_FREE_WINDOW,
    });
  });
});

describe("shiftDate", () => {
  it("月・年をまたいでずらせる", () => {
    assert.equal(shiftDate("2026-09-30", 1), "2026-10-01");
    assert.equal(shiftDate("2026-12-31", 1), "2027-01-01");
    assert.equal(shiftDate("2026-03-01", -1), "2026-02-28");
  });

  it("実在しない日付は null（繰り上げた別の日にしない）", () => {
    assert.equal(shiftDate("2026-02-30", 1), null);
    assert.equal(shiftDate("2026-13-01", 1), null);
  });
});

describe("resolveDate", () => {
  // 2026-09-19 23:30 JST。UTCではまだ18日なので、「今日」をUTCで切ると1日ずれる。
  const now = new Date("2026-09-19T14:30:00Z");

  it("offsetDays が無ければ date をそのまま使う（省略ならDaySpan側の今日）", () => {
    assert.equal(resolveDate({ date: "2026-10-01" }, now), "2026-10-01");
    assert.equal(resolveDate({}, now), undefined);
    assert.equal(resolveDate({ offsetDays: 0 }, now), undefined);
  });

  it("date が無ければJSTの今日からずらす", () => {
    assert.equal(resolveDate({ offsetDays: 1 }, now), "2026-09-20");
    assert.equal(resolveDate({ offsetDays: -1 }, now), "2026-09-18");
    assert.equal(resolveDate({ offsetDays: 1 }, new Date("2026-09-19T15:00:00Z")), "2026-09-21");
  });

  it("date があればそこからずらす", () => {
    assert.equal(resolveDate({ date: "2026-10-01", offsetDays: 2 }, now), "2026-10-03");
  });

  it("範囲外の offsetDays は丸める", () => {
    assert.equal(resolveDate({ date: "2026-01-01", offsetDays: 1000 }, now), "2026-04-01");
    assert.equal(resolveDate({ date: "2026-01-01", offsetDays: -1000 }, now), "2025-12-01");
  });

  it("整数でない offsetDays・読めない date は無視する", () => {
    assert.equal(resolveDate({ offsetDays: 1.5 }, now), undefined);
    assert.equal(resolveDate({ offsetDays: "1" }, now), undefined);
    assert.equal(resolveDate({ date: "明日", offsetDays: 1 }, now), "2026-09-20");
  });

  it("実在しない date はずらさずそのまま渡す", () => {
    assert.equal(resolveDate({ date: "2026-02-30", offsetDays: 1 }, now), "2026-02-30");
  });
});

describe("aide_schedule の宣言", () => {
  it("`aide_daily_briefing` との使い分けを説明文に書いている", () => {
    // 横断ビュー同士でも、選択が曖昧になればMCP層を狭くしている意味が無くなる。
    assert.match(scheduleTool.description, /aide_daily_briefing/);
    assert.match(scheduleTool.description, /終日の予定は時間帯を持たない/);
  });

  it("相対的な日は offsetDays で指定するよう説明文に書いている", () => {
    // 呼び出し側のAIに日付を計算させると、今日の取り違えがそのまま答えのずれになる。
    assert.match(scheduleTool.description, /offsetDays/);
  });

  it("知らない引数を受け付けない", () => {
    assert.equal(scheduleTool.inputSchema["additionalProperties"], false);
  });
});
