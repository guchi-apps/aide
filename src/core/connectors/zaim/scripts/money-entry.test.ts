import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { listItemKeys, toRawEntry } from "./money-entry.mjs"

// 明細JSON（/money/details）の1件。項目名は編集画面の Receipt と旧公式APIに合わせた想定で、値は架空（aide#759）
const item = {
    id: 9000000001,
    parsed_date: "2026-11-01T00:00:00+09:00",
    amount: 1000,
    category_name: "食費",
    label: "外食",
    from_account_name: "テストカード",
    to_account_name: "",
    place: "テスト店",
    name: "ランチ",
    comment: "",
    mode: "payment",
    from_account_id: 12,
    to_account_id: 0,
    child_ids: [9000000002, "9000000003"],
    calc_flag: 10,
}

describe("toRawEntry", () => {
    it("種別・口座id・子明細id・集計の設定を拾う", () => {
        const raw = toRawEntry(item)
        assert.equal(raw.mode, "payment")
        assert.equal(raw.fromAccountId, 12)
        assert.equal(raw.toAccountId, 0)
        assert.deepEqual(raw.childIds, [9000000002, 9000000003])
        assert.equal(raw.calcFlag, 10)
        assert.equal(raw.isoDate, "2026-11-01")
    })

    it("項目が無ければ付けない（旧形式と同じ形のまま）", () => {
        const { mode: _m, from_account_id: _f, to_account_id: _t, child_ids: _c, calc_flag: _k, ...old } = item
        const raw = toRawEntry(old)
        assert.equal(raw.mode, undefined)
        assert.equal(raw.fromAccountId, undefined)
        assert.equal(raw.toAccountId, undefined)
        assert.equal(raw.childIds, undefined)
        assert.equal(raw.calcFlag, undefined)
    })

    it("数として読めないidは null", () => {
        assert.equal(toRawEntry({ ...item, from_account_id: null }).fromAccountId, null)
        assert.equal(toRawEntry({ ...item, calc_flag: "x" }).calcFlag, null)
    })
})

describe("listItemKeys", () => {
    it("項目の名前だけを重複なく並べる（値は持ち出さない）", () => {
        assert.deepEqual(listItemKeys([{ b: 1, a: 2 }, { a: 3, c: "秘密" }]), ["a", "b", "c"])
        assert.deepEqual(listItemKeys(null), [])
    })
})
