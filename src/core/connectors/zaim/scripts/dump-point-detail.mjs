import { ZAIM_CONTEXT_OPTIONS } from "./context.mjs"
import { resolveStatePath } from "./paths.mjs"
import { loadPlaywright } from "./playwright-loader.mjs"
import { assertLoggedIn } from "./session-check.mjs"
import { POINT_ROW_SELECTOR } from "./points.mjs"

/**
 * 調査用（#901）: 「現在のポイント」の各詳細ページ（`/point_accounts/<id>`）に
 * 有効期限別の内訳があるかを確かめるため、ページの本文テキストと、クラス名つきの
 * DOMの骨格だけを標準出力へ出す。**読み取り専用**（Cookieの保存し直しも書き込み操作もしない）。
 *
 * 出力にはCookie・トークンを含めない（テキストとタグ・class・hrefのパス部分のみ）。
 * 実行は人が行う: `node --env-file-if-exists=.env src/core/connectors/zaim/scripts/dump-point-detail.mjs`
 */
const PAGE_TIMEOUT = 60_000

const balanceUrl = process.env.ZAIM_BALANCE_URL
if (!balanceUrl) {
    console.error("ZAIM_BALANCE_URL が未設定です")
    process.exit(1)
}

const { chromium } = await loadPlaywright()
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ storageState: resolveStatePath(), ...ZAIM_CONTEXT_OPTIONS })
const page = await context.newPage()

/** ブラウザ内で実行される（モジュールスコープを参照しない）。 */
function outline() {
    const root = document.querySelector("main") ?? document.body
    const lines = []
    const walk = (element, depth) => {
        if (depth > 12) return
        const tag = element.tagName.toLowerCase()
        if (["script", "style", "svg", "noscript"].includes(tag)) return
        const cls = element.getAttribute("class")
        const own = [...element.childNodes]
            .filter((node) => node.nodeType === 3)
            .map((node) => node.textContent.replace(/\s+/g, " ").trim())
            .filter(Boolean)
            .join(" | ")
        lines.push(`${"  ".repeat(depth)}<${tag}${cls ? ` class="${cls}"` : ""}>${own ? ` ${own}` : ""}`)
        for (const child of element.children) walk(child, depth + 1)
    }
    walk(root, 0)
    return lines.join("\n")
}

try {
    await page.goto(balanceUrl, { waitUntil: "networkidle", timeout: PAGE_TIMEOUT })
    await assertLoggedIn(page)
    const links = await page
        .locator(POINT_ROW_SELECTOR)
        .evaluateAll((elements) =>
            elements.map((a) => ({
                name: (a.querySelector(".name")?.textContent ?? "").replace(/\s+/g, " ").trim(),
                path: new URL(a.getAttribute("href"), location.href).pathname,
            })),
        )
    const origin = new URL(balanceUrl).origin
    for (const link of links) {
        await page.goto(origin + link.path, { waitUntil: "networkidle", timeout: PAGE_TIMEOUT })
        await assertLoggedIn(page)
        console.log(`===== ${link.name} ${link.path} =====`)
        console.log(await page.evaluate(outline))
    }
} finally {
    await browser.close()
}
