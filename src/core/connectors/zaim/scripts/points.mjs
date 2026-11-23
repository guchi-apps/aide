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

/**
 * 詳細ページ（`/point_accounts/<id>`）の「有効期限」タブ。見出し行（`th`）の下に
 * `<td>2027-01-31</td><td>1,729 pt</td>` の行が期限の早い順に並ぶ（#901）。
 * 残高が無いサービスは見出し行だけ。
 */
export const EXPIRATION_ROW_SELECTOR = ".description table tr"

/** ページ内で実行される。モジュールスコープの変数は参照できない。 */
export function extractExpirationRows(rows) {
    const clean = (text) => (text ?? "").replace(/\s+/g, " ").trim()
    const results = []
    for (const row of rows) {
        const cells = row.querySelectorAll("td")
        if (cells.length < 2) continue
        results.push({ date: clean(cells[0].textContent), amount: clean(cells[1].textContent) })
    }
    return results
}

/** 詳細ページを開いた状態で、期限別の内訳（表示のまま）を読む。 */
export async function readExpirations(page) {
    return page.locator(EXPIRATION_ROW_SELECTOR).evaluateAll(extractExpirationRows)
}

export async function readPoints(page) {
    return page.locator(POINT_ROW_SELECTOR).evaluateAll(extractPointRows)
}
