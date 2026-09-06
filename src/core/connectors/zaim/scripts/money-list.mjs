import { ZAIM_CONTEXT_OPTIONS } from "./context.mjs"
import { resolveStatePath } from "./paths.mjs"
import { loadPlaywright } from "./playwright-loader.mjs"
import { assertLoggedIn } from "./session-check.mjs"

const PAGE_TIMEOUT = 60_000

// Zaim側のCSS Modulesはクラス名の末尾にビルドごとのハッシュを付ける
// （例: "SearchResult-module__date___2mixB"）。ハッシュは変わりうるため、
// 接頭辞の部分一致で拾う。行そのものだけは念のため環境変数で上書きできるようにしておく。
const ROW_SELECTOR = process.env.ZAIM_MONEY_ROW_SELECTOR || '[class*="SearchResult-module__body"]'

function readMonth() {
    const month = process.env.ZAIM_MONEY_MONTH
    if (!month || !/^\d{6}$/.test(month)) {
        throw new Error("ZAIM_MONEY_MONTH を YYYYMM 形式で指定してください")
    }
    return month
}

function resolveMoneyUrl(month) {
    const base = process.env.ZAIM_MONEY_URL || "https://zaim.net/money"
    return `${base}?month=${month}`
}

// ブラウザコンテキストで実行される（DOM操作のみ。外側のスコープは参照できない）。
function extractMoneyRows(rows) {
    const text = (el) => (el?.textContent ?? "").trim()
    const find = (row, part) => row.querySelector(`[class*="SearchResult-module__${part}"]`)

    return rows.map((row) => {
        const editUrl = row.querySelector("[data-url]")?.getAttribute("data-url") ?? ""
        const categoryIcon = find(row, "category")?.querySelector("[data-title]")
        const accountImg = find(row, "fromAccount")?.querySelector("img")

        return {
            editUrl,
            date: text(find(row, "date")),
            category: categoryIcon?.getAttribute("data-title") ?? "",
            genre: text(find(row, "category")?.querySelector('[class*="SearchResult-module__link"]')),
            amount: text(find(row, "price")),
            account: accountImg?.getAttribute("alt") ?? "",
            toAccount: text(find(row, "toAccount")),
            place: text(find(row, "place")),
            name: text(find(row, "name")),
            comment: text(find(row, "comment")),
        }
    })
}

const { chromium } = await loadPlaywright()
const statePath = resolveStatePath()
const month = readMonth()
const url = resolveMoneyUrl(month)

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ storageState: statePath, ...ZAIM_CONTEXT_OPTIONS })
const page = await context.newPage()

try {
    await page.goto(url, { waitUntil: "networkidle", timeout: PAGE_TIMEOUT })
    await assertLoggedIn(page)

    const entries = await page.locator(ROW_SELECTOR).evaluateAll(extractMoneyRows)

    // 巡回・登録と同様、開いたついでにセッションを延長しておく。
    await context.storageState({ path: statePath })

    process.stdout.write(JSON.stringify({ url, month, entries }))
} finally {
    await browser.close()
}
