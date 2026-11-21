/**
 * ホーム画面（`ZAIM_BALANCE_URL`）の「現在のポイント」区画（`.row.list-points`）から
 * ポイント・マイルの残高を取り出す。
 *
 * 1件は `<a href="/point_accounts/<id>">` で、中に `.name`（表示名）と `.value`
 * （`N pt` と `.point-currency` の `¥N 相当`）がある。残高が無いものは `-`。
 * **`.point-currency` の円換算は数量ではないので落とす**（残すと円の残高と取り違える）。
 */

export const POINT_ROW_SELECTOR = '.list-points a[href*="/point_accounts/"]'

/**
 * ページ内で実行される。**この関数はブラウザへ文字列として渡されるため、
 * モジュールスコープの変数を参照できない。**
 */
export function extractPointRows(elements) {
    const clean = (text) => (text ?? "").replace(/\s+/g, " ").trim()
    const results = []
    for (const link of elements) {
        const name = clean(link.querySelector(".name")?.textContent)
        const valueElement = link.querySelector(".value")
        if (!name || !valueElement) continue
        const copy = valueElement.cloneNode(true)
        for (const currency of copy.querySelectorAll(".point-currency")) currency.remove()
        const href = link.getAttribute("href") ?? ""
        results.push({ name, amount: clean(copy.textContent), id: href.match(/\/point_accounts\/(\d+)/)?.[1] ?? "" })
    }
    return results
}

export async function readPoints(page) {
    return page.locator(POINT_ROW_SELECTOR).evaluateAll(extractPointRows)
}
