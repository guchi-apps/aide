import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_FREE_WINDOW } from "../../core/views/schedule.ts";
import { readFreeWindow, scheduleTool } from "./schedule.ts";

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

describe("aide_schedule の宣言", () => {
  it("`aide_daily_briefing` との使い分けを説明文に書いている", () => {
    // 横断ビュー同士でも、選択が曖昧になればMCP層を狭くしている意味が無くなる。
    assert.match(scheduleTool.description, /aide_daily_briefing/);
    assert.match(scheduleTool.description, /終日の予定は時間帯を持たない/);
  });

  it("知らない引数を受け付けない", () => {
    assert.equal(scheduleTool.inputSchema["additionalProperties"], false);
  });
});
