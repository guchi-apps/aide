/**
 * 連携口座一覧（`/online_accounts`）から「口座名 + 最終更新」を取り出す。
 *
 * Zaimの連携口座は「データを更新する」を押すまで各金融機関から再取得されない。
 * したがって**巡回が成功していても中身は何日も前の残高でありうる**。当日の値として
 * 扱ってよいかを参照側が判断できるよう、口座ごとの最終更新をそのまま持ち帰る。
 *
 * 日時の文字列はここでは解釈せず、表示のまま返す。ISO化と鮮度の判定は
 * `src/core/connectors/zaim/parse.ts` に置いてテストできるようにしている。
 */

/** 未設定でも動くように既定値を持つ。ボタンも最終更新もこのページにしか無い。 */
export function resolveOnlineAccountsUrl() {
    return process.env.ZAIM_ONLINE_ACCOUNTS_URL || "https://zaim.net/online_accounts"
}

/**
 * ページ内で実行される。**この関数はブラウザへ文字列として渡されるため、
 * モジュールスコープの変数を参照できない**（正規表現も中で作る）。
 *
 * クラス名はCSS Modulesのハッシュ付きでZaimのデプロイごとに変わるため当てにしない。
 * 「最終更新」を含む最小の要素を起点に、そこから親をたどって口座名を探す。
 */
export function extractOnlineAccounts(elements) {
    const pattern = /最終更新[：:]?\s*\d{4}年\s*\d{1,2}月\s*\d{1,2}日\s*\d{1,2}:\d{2}(?::\d{2})?/
    // Material Iconsは文字（`help_outline` 等）をそのままテキストに持つ。英小文字と
    // アンダースコアだけの語をアイコン文字として落とす。
    const ligature = /[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g
    // 連携が切れた行などに出る状態表示。口座名ではない。
    const statusPattern = /連携できない|連携エラー|連携が切れ|要再連携|更新できない|更新に失敗/g
    const clean = (text) => (text ?? "").replace(/\s+/g, " ").trim()
    const cleanName = (text) => clean(clean(text).replace(ligature, " ").replace(statusPattern, " "))
    const isIconElement = (el) => /material-(icons|symbols)/.test(String(el?.className ?? ""))
    const statusOf = (text) => clean(text).match(new RegExp(statusPattern.source))?.[0] ?? ""
    const candidates = (node) =>
        node.querySelectorAll
            ? [...node.querySelectorAll("h1, h2, h3, h4, h5, strong, a")]
            : [node.querySelector?.("h1, h2, h3, h4, h5, strong, a")].filter(Boolean)
    const results = []
    const seen = new Set()
    let unnamed = 0

    for (const element of elements) {
        const text = clean(element.textContent)
        const matched = text.match(pattern)
        if (!matched) continue
        // 親要素は子の分も含めて一致するため、最終更新を含む最小の要素だけを起点にする。
        if ([...element.children].some((child) => pattern.test(clean(child.textContent)))) continue

        const stamp = matched[0]
        let name = ""
        let status = ""
        // 口座名は最終更新の兄弟か、少し上の親にある。近い側から順に探す。
        for (let node = element, depth = 0; node && depth < 6; node = node.parentElement, depth += 1) {
            status = status || statusOf(node.textContent)
            for (const candidate of candidates(node)) {
                if (isIconElement(candidate)) continue
                const heading = cleanName(candidate.textContent)
                if (heading && heading.length <= 60 && !pattern.test(heading)) {
                    name = heading
                    break
                }
            }
            if (name) break
            // 見出しが無いレイアウトでは、ブロックのテキストから最終更新と金額を落として使う。
            const stripped = cleanName(
                clean(node.textContent)
                    // 親が複数行を含むと別の行の最終更新が残るため、すべて落とす。
                    .replace(new RegExp(pattern.source, "g"), " ")
                    .replace(/[￥¥]\s*-?[\d,]+/g, " ")
            )
            if (stripped && stripped.length <= 60) {
                name = stripped
                break
            }
        }
        // 金融機関名が取れなくても、連携できない行は警告から外さず状態を口座名の代わりに出す。
        // parse側は口座名だけで重複を除くため、代替名は2件目以降に連番を付けて一意にする。
        if (!name && status) {
            unnamed += 1
            name = `口座名を取得できない連携口座・${status}${unnamed > 1 ? ` ${unnamed}` : ""}`
        }
        if (!name) continue

        const key = `${name}\u0000${stamp}`
        if (seen.has(key)) continue
        seen.add(key)
        results.push({ name, lastUpdatedAt: stamp })
    }

    return results
}

/** セレクタを指定できた場合の抽出。総当たりより誤検出が少ない。 */
export function extractOnlineAccountsByRow(rows, selectors) {
    const pattern = /最終更新[：:]?\s*\d{4}年\s*\d{1,2}月\s*\d{1,2}日\s*\d{1,2}:\d{2}(?::\d{2})?/
    const clean = (text) => (text ?? "").replace(/\s+/g, " ").trim()

    return rows
        .map((row) => ({
            name: clean(row.querySelector(selectors.name)?.textContent),
            lastUpdatedAt: clean(row.textContent).match(pattern)?.[0] ?? "",
        }))
        .filter((account) => account.name && account.lastUpdatedAt)
}

/**
 * 連携口座一覧のページを開いている `page` から口座と最終更新を読む。
 * セレクタが両方設定されていればそちらを使い、無ければ総当たりで拾う
 * （残高一覧の抽出と同じ組み立て）。
 */
export async function readOnlineAccounts(page) {
    const rowSelector = process.env.ZAIM_ONLINE_ACCOUNT_ROW_SELECTOR
    const nameSelector = process.env.ZAIM_ONLINE_ACCOUNT_NAME_SELECTOR
    if (rowSelector && nameSelector) {
        return page
            .locator(rowSelector)
            .evaluateAll(extractOnlineAccountsByRow, { name: nameSelector })
    }
    return page
        .locator("div, li, section, article, tr, td, p, span")
        .evaluateAll(extractOnlineAccounts)
}
