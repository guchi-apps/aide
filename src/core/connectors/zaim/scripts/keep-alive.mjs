import { resolveStatePath } from "./paths.mjs"
import { loadPlaywright } from "./playwright-loader.mjs"
import { assertLoggedIn } from "./session-check.mjs"

/**
 * Zaimのセッション維持だけを行う。
 *
 * 認証Cookieは2時間で失効するが、巡回のたびにその時点から2時間後へ延長される。
 * 評価額の取得は画面のボタンから行うため、ここでは残高画面を1ページ開いて
 * 更新後のCookieを保存し直すだけにして、負荷とZaimへのアクセスを最小限にする。
 */
const PAGE_TIMEOUT = 60_000

const balanceUrl = process.env.ZAIM_BALANCE_URL
const statePath = resolveStatePath()

// 未設定の環境へデプロイされても失敗させない。
if (!balanceUrl) {
    console.log("Zaimセッション維持は未設定のためスキップします（ZAIM_BALANCE_URL）")
    process.exit(0)
}

const { chromium } = await loadPlaywright()
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ storageState: statePath })
const page = await context.newPage()

try {
    await page.goto(balanceUrl, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT })

    await assertLoggedIn(page)

    await context.storageState({ path: statePath })
    console.log("✅ Zaimのセッションを延長しました")
} catch (error) {
    console.error("❌ Zaimのセッション維持に失敗しました", error)
    process.exitCode = 1
} finally {
    await browser.close()
}
