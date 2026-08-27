import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideStaleAccountCheck, isFinalSyncOfDay } from "./zaim-sync.ts";

/**
 * 「その日の最後の巡回か」の判定。
 *
 * 口座の更新漏れは「最終更新が当日（JST）か」で見るため、昼の巡回では正常な口座まで
 * 当日でない側に入る。判定してよいのは、日付が変わるまでにもう巡回する機会が無い実行だけ
 * （#165。詳細は `isFinalSyncOfDay` のコメント）。
 *
 * 判定は以前 `zaim-refresh`（押下側）に置いていたが、押した直後には反映が遅い口座が
 * まだ進んでおらず、遅いだけの口座を毎晩警告していたため巡回側へ移した（#178）。
 */
describe("その日の最後の巡回かの判定", () => {
  it("23:35 JST の巡回では判定する", () => {
    // UTC 14:35 は JST 23:35（deploy/systemd/aide-zaim-sync.timer の夜の1回）。
    assert.equal(isFinalSyncOfDay(new Date("2026-08-16T14:35:00.000Z")), true);
  });

  it("11:35 JST の巡回では判定しない", () => {
    // UTC 02:35 は JST 11:35（同じタイマーの昼の1回）。ここで判定すると、前夜に
    // 更新できた口座まで「更新できなかった」になり、夜の実行で復旧が届く。
    assert.equal(isFinalSyncOfDay(new Date("2026-08-16T02:35:00.000Z")), false);
  });

  it("巡回が長引いて時刻がずれても、夜の実行は判定側のまま", () => {
    // 証券詳細ページまで辿るため、終了時刻は実行開始とずれる。
    assert.equal(isFinalSyncOfDay(new Date("2026-08-16T14:50:00.000Z")), true);
    // 昼の巡回が長引いても、まだ夜の巡回が残っている。
    assert.equal(isFinalSyncOfDay(new Date("2026-08-16T02:55:00.000Z")), false);
  });

  it("システムTZがUTCでもJSTの時刻で見る", () => {
    // UTC 2026-08-16 20:00 は JST 翌日 05:00。UTCの時刻で見ると判定側に倒れてしまう。
    assert.equal(isFinalSyncOfDay(new Date("2026-08-16T20:00:00.000Z")), false);
  });
});

/**
 * 更新漏れを判定するかどうかの決め方。
 *
 * **「警告が出ていない」と「判定していない」は別**で、混ぜると `notifyStaleAccounts` が
 * 未解決の記録を消して「復旧しました」を誤って送る。判定しない場合は口座の配列ではなく
 * `null` を返し、通知を呼ばせない。
 */
describe("更新漏れを判定するかの決め方", () => {
  // UTC 14:35 は JST 23:35（その日の最後の巡回）。
  const 夜の巡回 = new Date("2026-08-16T14:35:00.000Z");
  // UTC 02:35 は JST 11:35（昼の巡回）。
  const 昼の巡回 = new Date("2026-08-16T02:35:00.000Z");

  const 当日 = { name: "三菱UFJ銀行", lastUpdatedAt: "2026-08-16T22:31:00+09:00" };
  const 前日 = { name: "SBI 証券", lastUpdatedAt: "2026-08-15T23:50:43+09:00" };

  it("夜の巡回では当日でない口座を返す", () => {
    const { stale, note } = decideStaleAccountCheck([当日, 前日], 夜の巡回);
    assert.deepEqual(stale, [前日]);
    assert.match(note, /当日になっていない口座 1 件/);
  });

  it("夜の巡回で全部が当日なら、空の配列を返して復旧を通知させる", () => {
    // ここは null ではなく空配列。直ったことを通知側へ伝える必要がある。
    assert.deepEqual(decideStaleAccountCheck([当日], 夜の巡回), { stale: [], note: "" });
  });

  it("連携口座を1件も読めなかったときは判定しない", () => {
    // 巡回は連携口座一覧の取得に失敗しても残高・保有銘柄を返すため、空配列で来うる
    // （scripts/scrape.mjs が例外を握って onlineAccounts = [] のまま返す）。
    // これを「更新漏れ0件」と読むと、未解決の記録が消えて誤った復旧通知になる（#178）。
    const { stale, note } = decideStaleAccountCheck([], 夜の巡回);
    assert.equal(stale, null);
    assert.match(note, /読めなかった/);
  });

  it("昼の巡回では判定しない", () => {
    const { stale, note } = decideStaleAccountCheck([当日, 前日], 昼の巡回);
    assert.equal(stale, null);
    assert.match(note, /その日の最後の巡回/);
  });
});
