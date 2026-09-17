import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ZaimMoneyEntry } from "../../core/connectors/zaim/types.ts";
import { currentZaimMonth, mergeZaimMoneyLists, previousZaimMonth } from "./zaim-money-sync.ts";

function entry(id: number | null, date: string): ZaimMoneyEntry {
  return {
    id,
    date,
    amount: 100,
    category: "食費",
    genre: "外食",
    account: "財布",
    toAccount: "",
    place: "",
    name: "",
    comment: "",
  };
}

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

/**
 * 先月（JST）の算出。
 *
 * `currentZaimMonth` に依存しており、年またぎ（1月→前年12月）の繰り下げだけを追加で確かめる。
 */
describe("先月（JST）の算出", () => {
  it("通常の月では前月を返す", () => {
    assert.equal(previousZaimMonth(new Date("2026-06-15T03:00:00.000Z")), "202605");
  });

  it("1月なら前年12月を返す", () => {
    // JST 2026-01-01T00:30。
    assert.equal(previousZaimMonth(new Date("2025-12-31T15:30:00.000Z")), "202512");
  });
});

/**
 * 複数月ぶんの取得結果のマージ。
 *
 * asset-manager側の候補探索が同じ明細を二重に見ないよう、idの重複除去が要になる。
 */
describe("複数月ぶんの取得結果のマージ", () => {
  it("monthsを結合し、同じidの明細は先に渡した方を残す", () => {
    const previous = {
      entries: [entry(1, "2026-08-31"), entry(2, "2026-08-15")],
      months: ["202608"],
    };
    const current = {
      // id=2 は前月分（実際にはあり得ない境界ケースだが、防御として重複を落とす）と衝突させる。
      entries: [entry(2, "2026-08-15"), entry(3, "2026-09-01")],
      months: ["202609"],
    };

    const merged = mergeZaimMoneyLists([previous, current]);

    assert.deepEqual(merged.months, ["202608", "202609"]);
    assert.deepEqual(
      merged.entries.map((e) => e.id),
      [1, 2, 3],
    );
  });

  it("idがnullの明細は重複除去の対象にせずそのまま残す", () => {
    const list = { entries: [entry(null, "2026-09-01"), entry(null, "2026-09-02")], months: ["202609"] };

    const merged = mergeZaimMoneyLists([list]);

    assert.equal(merged.entries.length, 2);
  });
});
