import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { buildReceiptDetail, extractGenreNames, extractJsonAssignment } from "./receipt-detail.mjs"

// 実物（2026-10。/money/{id}/edit）の構造をそのまま縮めたもの。値は架空。
function editPage(receipt: unknown): string {
    const master = {
        genres: [
            { id: 11, label: "食料品", code: "0101", category_id: 101 },
            { id: 12, label: "買い物袋", code: "1101", category_id: 202 },
        ],
        categoryMap: { "101": { name: "食費", color: "#f00" }, "202": { name: "日用品", color: "#0f0" } },
    }
    return `<html><script>var PaymentInputVariables = ${JSON.stringify(master)}
  var Receipt = ${JSON.stringify(receipt)} var Currency = {"point":0,"unit":"\\"}</script></html>`
}

const receipt = {
    id: 100,
    from_account_id: 1,
    date: "2026-10-06",
    place: "テスト店",
    calc_flag: 10,
    items: [
        { id: 100, name: "玉子L6個入", genre_id: 11, amount: 199, comment: "" },
        { id: 101, name: "豚こま切れ", genre_id: 11, amount: 365, comment: "" },
        { id: 102, name: "税金・値引き", genre_id: 12, amount: 114, comment: "" },
    ],
}
const entry = { id: 100, isoDate: "2026-10-06", amount: 678, childCount: 2 }
const ok = (r: unknown) => ({ ok: true, status: 200, html: editPage(r) })

describe("extractJsonAssignment", () => {
    it("文字列中の波括弧や末尾の別変数に惑わされない", () => {
        const html = `var Receipt = {"a":"}{\\"x","b":{"c":1}} var Other = {"z":2}`
        assert.deepEqual(extractJsonAssignment(html, "Receipt"), { a: '}{"x', b: { c: 1 } })
    })
    it("無い・壊れている場合は null", () => {
        assert.equal(extractJsonAssignment("<html></html>", "Receipt"), null)
        assert.equal(extractJsonAssignment('var Receipt = {"a":', "Receipt"), null)
    })
})

describe("extractGenreNames", () => {
    it("ジャンルidからカテゴリ名と内訳名を引く", () => {
        assert.deepEqual(extractGenreNames(editPage(receipt)).get(11), { genre: "食料品", category: "食費" })
    })
})

describe("buildReceiptDetail", () => {
    it("件数も合計も一致すれば complete。全行（税金・値引きも）を順に返す", () => {
        const detail = buildReceiptDetail(entry, ok(receipt))
        assert.equal(detail.status, "complete")
        assert.deepEqual(detail.items?.map((i) => [i.name, i.amount, i.genre, i.category]), [
            ["玉子L6個入", 199, "食料品", "食費"],
            ["豚こま切れ", 365, "食料品", "食費"],
            ["税金・値引き", 114, "買い物袋", "日用品"],
        ])
        assert.equal(detail.items?.[0]?.quantity, null)
    })

    it("子明細を持たない通常明細は none（編集画面は読みに行かない）", () => {
        assert.deepEqual(buildReceiptDetail({ ...entry, childCount: 0 }, null), { status: "none" })
    })

    it("合計だけ合っていても件数が合わなければ complete にしない", () => {
        const detail = buildReceiptDetail({ ...entry, childCount: 3 }, ok(receipt))
        assert.equal(detail.status, "partial")
        assert.equal(detail.items?.length, 3)
    })

    it("件数が合っても合計が合わなければ partial", () => {
        assert.equal(buildReceiptDetail({ ...entry, amount: 700 }, ok(receipt)).status, "partial")
    })

    it("取得失敗・Receiptなし・別取引・行の欠けは failed で、items を返さない", () => {
        const cases = [
            { ok: false, status: 500 },
            { ok: true, status: 200, html: "<html></html>" },
            ok({ ...receipt, id: 999 }),
            ok({ ...receipt, date: "2026-10-07" }),
            ok({ ...receipt, items: [{ id: 1, name: "", genre_id: 11, amount: 678, comment: "" }] }),
        ]
        for (const page of cases) {
            const detail = buildReceiptDetail(entry, page)
            assert.equal(detail.status, "failed")
            assert.equal(detail.items, undefined)
            assert.ok(detail.reason)
        }
    })

    it("値引き・割引の負の金額もそのまま持つ", () => {
        const detail = buildReceiptDetail(
            { id: 100, isoDate: "2026-10-06", amount: 90, childCount: 1 },
            ok({ ...receipt, items: [
                { id: 100, name: "商品", genre_id: 11, amount: 100, comment: "" },
                { id: 101, name: "値引き", genre_id: 12, amount: -10, comment: "" },
            ] }),
        )
        assert.equal(detail.status, "complete")
        assert.equal(detail.items?.[1]?.amount, -10)
    })
})
