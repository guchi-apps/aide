import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { tokyoDate } from "./tokyo-date.ts";

describe("tokyoDate", () => {
  it("UTCで前日になる時刻でも日本時間の日付を返す", () => {
    // UTC 2026-08-15 23:00 は JST 2026-08-16 08:00。
    assert.equal(tokyoDate(new Date("2026-08-15T23:00:00.000Z")), "2026-08-16");
    assert.equal(tokyoDate(new Date("2026-08-16T14:59:00.000Z")), "2026-08-16");
    assert.equal(tokyoDate(new Date("2026-08-16T15:00:00.000Z")), "2026-08-17");
  });
});
