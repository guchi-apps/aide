import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ZaimMoneyEntry } from "../../core/connectors/zaim/types.ts";
import { mergeZaimMoneyLists } from "./zaim-money-sync.ts";

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
