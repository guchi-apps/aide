import { ZAIM_CONTEXT_OPTIONS } from "./context.mjs"
import { resolveStatePath } from "./paths.mjs"
import { loadPlaywright } from "./playwright-loader.mjs"
import { assertLoggedIn } from "./session-check.mjs"

const PAGE_TIMEOUT = 60_000

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

function resolveDetailsUrl(month) {
    const base = process.env.ZAIM_MONEY_DETAILS_URL || `${process.env.ZAIM_MONEY_URL || "https://zaim.net/money"}/details`
    return `${base}?month=${month}`
}

// ブラウザコンテキストで実行される（外側のスコープは参照できない）。
// 一覧画面は仮想スクロールで、DOMには最初の23行ほどしか描かれない（aide#481）。同じ画面が
// 裏で読んでいる JSON は月ぶんの全件を返すため、DOMではなくこちらを読む。
async function fetchDetails(detailsUrl) {
    const response = await fetch(detailsUrl, {
        credentials: "include",
        headers: { Accept: "application/json" },
    })
    if (!response.ok) throw new Error(`Zaim明細JSONの取得に失敗しました（HTTP ${response.status}）`)
    return await response.json()
}

// JSONの1件を、parse.ts の ZaimRawMoneyEntry へ寄せる。
function toRawEntry(item) {
    const s = (value) => (value == null ? "" : String(value))
    return {
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

    const details = await page.evaluate(fetchDetails, resolveDetailsUrl(month))
    if (!Array.isArray(details?.items)) {
        throw new Error("Zaim明細JSONの形式が想定と異なります（items が配列ではありません）")
    }
    const entries = details.items.map(toRawEntry)

    // 巡回・登録と同様、開いたついでにセッションを延長しておく。
    await context.storageState({ path: statePath })

    process.stdout.write(JSON.stringify({ url, month, entries }))
} finally {
    await browser.close()
}
