import { ZAIM_CONTEXT_OPTIONS } from "./context.mjs"
import { resolveStatePath } from "./paths.mjs"
import { loadPlaywright } from "./playwright-loader.mjs"
import { fetchDetails, readDetail, toRawEntry } from "./money-entry.mjs"
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
    const entries = []
    for (const item of details.items) {
        const raw = toRawEntry(item)
        // 同じ画面を続けて開くため、1件ずつ順に読む（Zaimへの負荷を抑える）。
        raw.detail = await readDetail(page, item, raw)
        entries.push(raw)
    }

    // 巡回・登録と同様、開いたついでにセッションを延長しておく。
    await context.storageState({ path: statePath })

    process.stdout.write(JSON.stringify({ url, month, entries }))
} finally {
    await browser.close()
}
