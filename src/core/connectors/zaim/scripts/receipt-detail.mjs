// スマートレシート・Amazon等の「商品内訳」を、取引の編集画面から読む判断（#596）。
//
// 一覧JSON（/money/details）は取引ごとに代表の品名と合計しか返さないが、`child_ids` に子明細の
// idが並ぶ。子明細は一覧に出ない。実物（2026-10）で確かめたところ、`/money/{id}/edit` のHTMLに
// `var Receipt = {id, date, place, items:[{id, name, genre_id, amount, comment}]}` が埋め込まれ、
// items は「親の1行＋子明細」の全行（税金・値引き・配送料も1行として入る）だった。
// ジャンル名は同じ画面の `var PaymentInputVariables = {genres, categoryMap}` で引く。
//
// 実装を `.mjs` に置いているのは他のスクリプト部品と同じ理由（テストから純粋関数として呼ぶため）。
// **読むだけ。** 編集画面を開くだけで、保存・送信は行わない。

/**
 * HTML中の `var <name> = {...}` のJSONオブジェクトを読む。無い・壊れていれば null。
 * 文字列中の波括弧を数えないよう、引用符の中は読み飛ばす。
 */
export function extractJsonAssignment(html, name) {
    const marker = `var ${name} = `
    const at = html.indexOf(marker)
    if (at < 0) return null
    const start = at + marker.length
    if (html[start] !== "{") return null

    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < html.length; i++) {
        const c = html[i]
        if (inString) {
            if (escaped) escaped = false
            else if (c === "\\") escaped = true
            else if (c === '"') inString = false
            continue
        }
        if (c === '"') inString = true
        else if (c === "{") depth++
        else if (c === "}" && --depth === 0) {
            try {
                return JSON.parse(html.slice(start, i + 1))
            } catch {
                return null
            }
        }
    }
    return null
}

/** 編集画面のジャンルid→{genre, category}の対応。読めなければ空。 */
export function extractGenreNames(html) {
    const master = extractJsonAssignment(html, "PaymentInputVariables")
    const names = new Map()
    if (!master || !Array.isArray(master.genres)) return names
    const categories = master.categoryMap && typeof master.categoryMap === "object" ? master.categoryMap : {}
    for (const genre of master.genres) {
        if (typeof genre?.id !== "number" || typeof genre.label !== "string") continue
        const category = categories[String(genre.category_id)]?.name
        names.set(genre.id, { genre: genre.label, category: typeof category === "string" ? category : "" })
    }
    return names
}

function text(value) {
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : ""
}

/**
 * 一覧の1件と、その編集画面のHTMLから、商品内訳の取得結果を作る。**純粋関数。**
 *
 * - `none`     … 子明細を持たない通常明細。編集画面には品名の空の1行があるだけで内訳ではない
 * - `complete` … 件数が「子明細＋親の1行」と一致し、金額の合計も取引合計と一致する
 * - `partial`  … 商品行は読めたが、件数か合計が合わない（一部しか取れていない可能性）
 * - `failed`   … 取得・解析に失敗した。**このとき items は返さない**（代表商品へ合計を載せた行を作らない）
 *
 * **合計が一致しただけでは complete にしない。** 件数も合っていることを条件にする。
 *
 * @param {{ id: number, isoDate: string, amount: number, childCount: number }} entry
 * @param {{ ok: boolean, status?: number, html?: string }} page 編集画面の取得結果
 */
export function buildReceiptDetail(entry, page) {
    if (entry.childCount === 0) return { status: "none" }
    if (!page?.ok || typeof page.html !== "string") {
        return { status: "failed", reason: `取引の編集画面を取得できませんでした（HTTP ${page?.status ?? "不明"}）` }
    }

    const receipt = extractJsonAssignment(page.html, "Receipt")
    if (!receipt || !Array.isArray(receipt.items)) {
        return { status: "failed", reason: "編集画面から商品の一覧（Receipt）を読めませんでした" }
    }
    // 別の取引の画面を読んでいないかを確かめる（同日同店舗の取引を混ぜない）。
    if (receipt.id !== entry.id || (entry.isoDate && receipt.date !== entry.isoDate)) {
        return { status: "failed", reason: "編集画面の取引が一覧の取引と一致しませんでした" }
    }

    const genres = extractGenreNames(page.html)
    const items = []
    for (const row of receipt.items) {
        const name = text(row?.name)
        if (!name || typeof row.amount !== "number" || !Number.isInteger(row.amount)) {
            return { status: "failed", reason: "商品名か金額を読めない行がありました" }
        }
        const names = genres.get(row.genre_id)
        items.push({
            id: typeof row.id === "number" ? row.id : null,
            name,
            amount: row.amount,
            // Zaimの画面には数量・単価・値引き額・税額の専用項目が無い（税金・値引きは独立した1行）。
            quantity: null,
            unitPrice: null,
            discount: null,
            tax: null,
            category: names?.category ?? "",
            genre: names?.genre ?? "",
        })
    }

    const sum = items.reduce((total, item) => total + item.amount, 0)
    const countMatches = items.length === entry.childCount + 1
    if (countMatches && sum === entry.amount) return { status: "complete", items }

    const reasons = []
    if (!countMatches) reasons.push(`商品行が${items.length}件（子明細${entry.childCount}件＋親1行と不一致）`)
    if (sum !== entry.amount) reasons.push(`商品の合計${sum}円が取引合計${entry.amount}円と不一致`)
    return { status: "partial", items, reason: reasons.join("・") }
}
