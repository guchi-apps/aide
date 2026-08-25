import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isFinalRefreshOfDay } from "./zaim-refresh.ts";

/**
 * 「その日の最後の押下か」の判定。
 *
 * 口座の更新漏れは「最終更新が当日（JST）か」で見るため、昼の押下では正常な口座まで
 * 当日でない側に入る。判定してよいのは、日付が変わるまでにもう押す機会が無い実行だけ
 * （#165。詳細は `isFinalRefreshOfDay` のコメント）。
 */
describe("その日の最後の押下かの判定", () => {
  it("23:15 JST の実行では判定する", () => {
    // UTC 14:15 は JST 23:15（deploy/systemd/aide-zaim-refresh.timer の夜の1回）。
    assert.equal(isFinalRefreshOfDay(new Date("2026-08-16T14:15:00.000Z")), true);
  });

  it("11:15 JST の実行では判定しない", () => {
    // UTC 02:15 は JST 11:15（同じタイマーの昼の1回）。ここで判定すると、前夜に
    // 更新できた口座まで「更新できなかった」になり、夜の実行で復旧が届く。
    assert.equal(isFinalRefreshOfDay(new Date("2026-08-16T02:15:00.000Z")), false);
  });

  it("押下が長引いて時刻がずれても、夜の実行は判定側のまま", () => {
    // 押してから最大15分待つため、終了時刻は実行開始とずれる。
    assert.equal(isFinalRefreshOfDay(new Date("2026-08-16T14:35:00.000Z")), true);
    // 昼の実行が上限まで待って終わっても、まだ夜の押下が残っている。
    assert.equal(isFinalRefreshOfDay(new Date("2026-08-16T02:40:00.000Z")), false);
  });

  it("システムTZがUTCでもJSTの時刻で見る", () => {
    // UTC 2026-08-16 20:00 は JST 翌日 05:00。UTCの時刻で見ると判定側に倒れてしまう。
    assert.equal(isFinalRefreshOfDay(new Date("2026-08-16T20:00:00.000Z")), false);
  });
});
