// 対象の1取引だけ、商品内訳をZaimから最新取得する（#600）。
//
// 月の一覧JSON（1リクエスト）から対象のidを探し、その取引の編集画面だけを開く。月全体の
// 取引ぶん編集画面を開く定期巡回（money-list.mjs）より、Zaimへの負荷も所要時間も小さい。
// **読むだけ。** 保存・送信は行わない。
//
// 入力は環境変数 ZAIM_RECEIPT_REFRESH_INPUT（JSON: { month, moneyId }）。引数に置くと `ps` に出る。
import { ZAIM_CONTEXT_OPTIONS } from "./context.mjs"
import { fetchDetails, readDetail, toRawEntry } from "./money-entry.mjs"
import { resolveStatePath } from "./paths.mjs"
import { loadPlaywright } from "./playwright-loader.mjs"
import { assertLoggedIn } from "./session-check.mjs"

const PAGE_TIMEOUT = 60_000

function readInput() {
    let input
    try {
        input = JSON.parse(process.env.ZAIM_RECEIPT_REFRESH_INPUT ?? "")
    } catch {
        throw new Error("ZAIM_RECEIPT_REFRESH_INPUT をJSONとして読めません")
    }
    if (!/^\d{6}$/.test(String(input?.month)) || !Number.isInteger(input?.moneyId)) {
        throw new Error("ZAIM_RECEIPT_REFRESH_INPUT には month（YYYYMM）と moneyId（整数）が必要です")
    }
    return input
}

const moneyBase = process.env.ZAIM_MONEY_URL || "https://zaim.net/money"
const detailsBase = process.env.ZAIM_MONEY_DETAILS_URL || `${moneyBase}/details`

const { chromium } = await loadPlaywright()
const statePath = resolveStatePath()
const { month, moneyId } = readInput()
const url = `${moneyBase}?month=${month}`

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ storageState: statePath, ...ZAIM_CONTEXT_OPTIONS })
const page = await context.newPage()

try {
    await page.goto(url, { waitUntil: "networkidle", timeout: PAGE_TIMEOUT })
    await assertLoggedIn(page)

    const details = await page.evaluate(fetchDetails, `${detailsBase}?month=${month}`)
    if (!Array.isArray(details?.items)) {
        throw new Error("Zaim明細JSONの形式が想定と異なります（items が配列ではありません）")
    }

    const item = details.items.find((candidate) => candidate?.id === moneyId)
    let entry = null
    if (item) {
        entry = toRawEntry(item)
        entry.detail = await readDetail(page, item, entry)
    }

    // 開いたついでにセッションを延長しておく（巡回・登録と同じ）。
    await context.storageState({ path: statePath })

    process.stdout.write(JSON.stringify({ url, month, entry }))
} finally {
    await browser.close()
}
