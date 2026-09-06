import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { currentZaimMonth } from "./zaim-money-sync.ts";

/**
 * 当月（JST）の算出。
 *
 * `fetchZaimMoneyList` へ渡す `YYYYMM` を決める境界なので、UTC日付とJST日付が
 * ずれる時刻（年末年始・月またぎの深夜）でも正しくJST側の月を返す必要がある。
 */
describe("当月（JST）の算出", () => {
  it("通常の時刻ではそのままの月を返す", () => {
    assert.equal(currentZaimMonth(new Date("2026-06-15T03:00:00.000Z")), "202606");
  });

  it("UTCでは前月でもJSTで月が変わっていれば新しい月を返す", () => {
    // UTC 2026-05-31T15:30 は JST 2026-06-01T00:30。
    assert.equal(currentZaimMonth(new Date("2026-05-31T15:30:00.000Z")), "202606");
  });

  it("UTCでは前年12月でもJSTで年が変わっていれば新年1月を返す", () => {
    // UTC 2025-12-31T20:00 は JST 2026-01-01T05:00 なので、翌年1月を返す必要がある。
    assert.equal(currentZaimMonth(new Date("2025-12-31T20:00:00.000Z")), "202601");
  });

  it("年またぎ（UTC 2025-12-31 深夜、JSTでも同日）は旧年の12月を返す", () => {
    // UTC 2025-12-31T10:00 は JST 2025-12-31T19:00。
    assert.equal(currentZaimMonth(new Date("2025-12-31T10:00:00.000Z")), "202512");
  });
});
