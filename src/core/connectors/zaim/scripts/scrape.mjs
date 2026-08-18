import { ZAIM_CONTEXT_OPTIONS } from "./context.mjs"
import { readOnlineAccounts, resolveOnlineAccountsUrl } from "./online-accounts.mjs"
import { resolveStatePath } from "./paths.mjs"
import { loadPlaywright } from "./playwright-loader.mjs"
import { assertLoggedIn } from "./session-check.mjs"

const PAGE_TIMEOUT = 60_000
const DEFAULT_SECURITIES_LINK_SELECTOR = 'a[href*="/securities/"]'
const ACCOUNT_NAME_MAX_LENGTH = 60

function collapseWhitespace(text) {
    return text.replace(/\s+/g, " ").trim()
}

// DOM構造が変わっても最低限拾えるよう、小さな表示ブロックから
// 「名称 + 円金額」の組を抽出する。実運用ではセレクタ指定を推奨する。
function extractGenericPairs(elements) {
    const yenPattern = /[￥¥]\s*-?[\d,]+/
    const candidates = []
    // 入れ子の親要素と子要素から同じ行を重複して拾うため、完全に同じ組は1件に畳む。
    const seen = new Set()
    for (const element of elements) {
        const text = element.textContent?.replace(/\s+/g, " ").trim() ?? ""
        if (!text || text.length > 180 || !yenPattern.test(text)) continue
        const match = text.match(yenPattern)
        if (!match) continue
        const name = text.replace(match[0], " ").replace(/\s+/g, " ").trim()
        if (!name || name.length > 80) continue
        const key = `${name}\u0000${match[0]}`
        if (seen.has(key)) continue
        seen.add(key)
        candidates.push({ name, amount: match[0] })
    }
    return candidates
}

function extractRowPairs(rows, selectors) {
    return rows.map((row) => ({
        name: row.querySelector(selectors.name)?.textContent ?? "",
        amount: row.querySelector(selectors.amount)?.textContent ?? "",
    }))
}

// 証券詳細ページへのリンクから、遷移先URLと口座名の候補を取り出す。
// リンクが行全体を包んでいる場合はテキストに金額が含まれるため、金額部分は落とす。
function extractSecuritiesLinks(links) {
    return links
        .map((link) => ({
            url: link.href,
            name: (link.textContent ?? "")
                .replace(/[￥¥]\s*-?[\d,]+/g, " ")
                .replace(/\s+/g, " ")
                .trim(),
        }))
        .filter((link) => Boolean(link.url))
}

// 証券詳細ページの表は「銘柄・保有株数・取得単価・現在値・評価額・評価損益」と
// 「銘柄・評価額」の2種類があり、評価額の列位置が揃わない。
// 列位置を決め打ちできないため、ヘッダー行の見出しから評価額の列を特定する。
function extractTableHoldings(tables, headers) {
    const normalize = (text) => (text ?? "").replace(/\s+/g, " ").trim()
    const results = []

    for (const table of tables) {
        const rows = [...table.querySelectorAll("tr")]
        const headerRow = rows.find((row) => row.querySelectorAll("th").length > 0)
        if (!headerRow) continue

        const headerTexts = [...headerRow.querySelectorAll("th")].map((th) =>
            normalize(th.textContent)
        )
        const amountIndex = headerTexts.findIndex((text) => headers.amount.includes(text))
        if (amountIndex < 0) continue

        const foundNameIndex = headerTexts.findIndex((text) => headers.name.includes(text))
        const nameIndex = foundNameIndex < 0 ? 0 : foundNameIndex

        for (const row of rows) {
            const cells = [...row.querySelectorAll("td")]
            if (cells.length <= Math.max(nameIndex, amountIndex)) continue
            results.push({
                name: cells[nameIndex].textContent ?? "",
                amount: cells[amountIndex].textContent ?? "",
            })
        }
    }

    return results
}

async function extractPairs(page, selectors) {
    if (selectors.row && selectors.name && selectors.amount) {
        return page
            .locator(selectors.row)
            .evaluateAll(extractRowPairs, { name: selectors.name, amount: selectors.amount })
    }
    return page.locator("tr, li, article, section, a, div").evaluateAll(extractGenericPairs)
}

async function extractHoldings(page, selectors, tableConfig) {
    if (selectors.row && selectors.name && selectors.amount) {
        return extractPairs(page, selectors)
    }

    const fromTables = await page
        .locator(tableConfig.selector)
        .evaluateAll(extractTableHoldings, {
            name: tableConfig.nameHeaders,
            amount: tableConfig.amountHeaders,
        })
    if (fromTables.length > 0) return fromTables

    return extractPairs(page, selectors)
}

/**
 * 証券口座名を決める。銘柄は口座ごとに分けて対応付けるため、
 * どの口座の銘柄かを示す名前が必須になる。
 */
async function resolveAccountName(page, linkName, accountNameSelector) {
    if (accountNameSelector) {
        const heading = page.locator(accountNameSelector).first()
        if ((await heading.count()) > 0) {
            const text = collapseWhitespace(await heading.innerText())
            if (text) return text
        }
    }
    if (linkName && linkName.length <= ACCOUNT_NAME_MAX_LENGTH) return linkName
    const title = collapseWhitespace(await page.title())
    if (title) return title
    return page.url()
}

const { chromium } = await loadPlaywright()
const statePath = resolveStatePath()
const balanceUrl = process.env.ZAIM_BALANCE_URL

if (!balanceUrl) {
    throw new Error("ZAIM_BALANCE_URL is not configured")
}

const balanceSelectors = {
    row: process.env.ZAIM_BALANCE_ROW_SELECTOR,
    name: process.env.ZAIM_BALANCE_NAME_SELECTOR,
    amount: process.env.ZAIM_BALANCE_AMOUNT_SELECTOR,
}
const holdingSelectors = {
    row: process.env.ZAIM_SECURITIES_HOLDING_ROW_SELECTOR,
    name: process.env.ZAIM_SECURITIES_HOLDING_NAME_SELECTOR,
    amount: process.env.ZAIM_SECURITIES_HOLDING_AMOUNT_SELECTOR,
}
const securitiesLinkSelector =
    process.env.ZAIM_SECURITIES_LINK_SELECTOR || DEFAULT_SECURITIES_LINK_SELECTOR
const accountNameSelector = process.env.ZAIM_SECURITIES_ACCOUNT_NAME_SELECTOR

function parseHeaderList(value, fallback) {
    if (!value) return fallback
    return value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
}

const holdingTableConfig = {
    selector: process.env.ZAIM_SECURITIES_HOLDING_TABLE_SELECTOR || "table",
    nameHeaders: parseHeaderList(process.env.ZAIM_SECURITIES_HOLDING_NAME_HEADERS, [
        "銘柄",
        "ファンド名",
    ]),
    amountHeaders: parseHeaderList(process.env.ZAIM_SECURITIES_HOLDING_AMOUNT_HEADERS, ["評価額"]),
}

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ storageState: statePath, ...ZAIM_CONTEXT_OPTIONS })
const page = await context.newPage()

try {
    await page.goto(balanceUrl, { waitUntil: "networkidle", timeout: PAGE_TIMEOUT })
    await assertLoggedIn(page)

    const balances = await extractPairs(page, balanceSelectors)

    // 証券は残高一覧に合計しか出ないため、詳細ページを巡回して個別銘柄を取得する。
    const securitiesLinks = await page
        .locator(securitiesLinkSelector)
        .evaluateAll(extractSecuritiesLinks)

    // 同じ口座へのリンクが複数あることがあるため、URL単位で1回だけ巡回する。
    const linkNameByUrl = new Map()
    for (const link of securitiesLinks) {
        if (!linkNameByUrl.get(link.url)) linkNameByUrl.set(link.url, link.name)
    }

    const securities = []
    for (const [securitiesUrl, linkName] of linkNameByUrl) {
        await page.goto(securitiesUrl, { waitUntil: "networkidle", timeout: PAGE_TIMEOUT })
        await assertLoggedIn(page)
        const account = await resolveAccountName(page, linkName, accountNameSelector)
        const holdings = await extractHoldings(page, holdingSelectors, holdingTableConfig)
        securities.push({ url: securitiesUrl, account, holdings })
    }

    // 連携口座の最終更新（#62）。Zaimは更新ボタンを押すまで再取得しないため、巡回できた
    // ことと中身が当日のものであることは別。当日の値として扱ってよいかを参照側が判断できる
    // ように持ち帰る。**ここが読めなくても残高・保有銘柄は返せるので巡回自体は失敗させない。**
    let onlineAccounts = []
    try {
        await page.goto(resolveOnlineAccountsUrl(), {
            waitUntil: "networkidle",
            timeout: PAGE_TIMEOUT,
        })
        await assertLoggedIn(page)
        onlineAccounts = await readOnlineAccounts(page)
    } catch (error) {
        // stdout はJSON専用なので stderr へ出す。
        console.error("連携口座の最終更新を取得できませんでした", error)
    }

    // Zaimの認証Cookieは数時間で失効する。巡回のたびに更新後のCookieを保存し直すことで、
    // 同期間隔が失効までの時間より短い限り、手動ログインなしでセッションを維持できる。
    await context.storageState({ path: statePath })

    process.stdout.write(JSON.stringify({ url: balanceUrl, balances, securities, onlineAccounts }))
} finally {
    await browser.close()
}
