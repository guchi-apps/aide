// 一覧スクリプト（money-list.mjs）と単件取得スクリプト（receipt-refresh.mjs。#600）が共有する、
// 明細JSONの取得と1件ぶんの組み立て。**読むだけで、何も送信しない。**
import { buildReceiptDetail } from "./receipt-detail.mjs"

// ブラウザコンテキストで実行される（外側のスコープは参照できない）。
// 一覧画面は仮想スクロールで、DOMには最初の23行ほどしか描かれない（aide#481）。同じ画面が
// 裏で読んでいる JSON は月ぶんの全件を返すため、DOMではなくこちらを読む。
export async function fetchDetails(detailsUrl) {
    const response = await fetch(detailsUrl, {
        credentials: "include",
        headers: { Accept: "application/json" },
    })
    if (!response.ok) throw new Error(`Zaim明細JSONの取得に失敗しました（HTTP ${response.status}）`)
    return await response.json()
}

// ブラウザコンテキストで実行される。取引の編集画面のHTMLを読むだけで、何も送信しない（#596）。
// 失敗しても例外にせず、状態として返す（1件の失敗で月全体の取得を落とさない）。
export async function fetchEditPage(editUrl) {
    try {
        const response = await fetch(editUrl, { credentials: "include" })
        if (!response.ok) return { ok: false, status: response.status }
        return { ok: true, status: response.status, html: await response.text() }
    } catch {
        return { ok: false, status: 0 }
    }
}

// 子明細を持つ取引（スマートレシート・Amazon等）だけ、編集画面から商品内訳を読む。
export async function readDetail(page, item, raw) {
    const childCount = Array.isArray(item.child_ids) ? item.child_ids.length : 0
    if (childCount === 0 || !item.id) return buildReceiptDetail({ id: item.id, isoDate: raw.isoDate, amount: Number(item.amount), childCount: 0 }, null)
    const origin = new URL(page.url()).origin
    const result = await page.evaluate(fetchEditPage, `${origin}${raw.editUrl}`)
    return buildReceiptDetail({ id: item.id, isoDate: raw.isoDate, amount: Number(item.amount), childCount }, result)
}

// 数値のid・フラグ。数でなければ null（文字列の数字は数にする）。
function toIntOrNull(value) {
    const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value
    return typeof n === "number" && Number.isInteger(n) ? n : null
}

// 一覧JSONの1件が持つ項目の**名前**を集める（値は持ち出さない）。項目名の確認用（aide#759）。
export function listItemKeys(items) {
    const keys = new Set()
    for (const item of Array.isArray(items) ? items : []) {
        if (item && typeof item === "object") for (const key of Object.keys(item)) keys.add(key)
    }
    return [...keys].sort()
}

// JSONの1件を、parse.ts の ZaimRawMoneyEntry へ寄せる。
// 種別・口座id・子明細id・集計の設定（aide#759）は、項目名を実物で確かめきれていないため、
// 無ければ付けない（undefined のまま）。名前は編集画面の Receipt（from_account_id・calc_flag）と、
// 旧公式APIの money（mode・to_account_id）に合わせてある。
export function toRawEntry(item) {
    const s = (value) => (value == null ? "" : String(value))
    const childIds = Array.isArray(item.child_ids) ? item.child_ids.map(toIntOrNull).filter((id) => id !== null) : undefined
    return {
        mode: typeof item.mode === "string" ? item.mode : undefined,
        fromAccountId: "from_account_id" in item ? toIntOrNull(item.from_account_id) : undefined,
        toAccountId: "to_account_id" in item ? toIntOrNull(item.to_account_id) : undefined,
        childIds,
        calcFlag: "calc_flag" in item ? toIntOrNull(item.calc_flag) : undefined,
        editUrl: item.id ? `/money/${item.id}/edit` : "",
        isoDate: s(item.parsed_date).slice(0, 10),
        date: "",
        category: s(item.category_name),
        genre: s(item.label),
        amount: s(item.amount),
        account: s(item.from_account_name),
        toAccount: s(item.to_account_name),
        place: s(item.place),
        name: s(item.name),
        comment: s(item.comment),
    }
}
