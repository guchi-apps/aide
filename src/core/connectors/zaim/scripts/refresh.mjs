import { ZAIM_CONTEXT_OPTIONS } from "./context.mjs"
import { readOnlineAccounts, resolveOnlineAccountsUrl } from "./online-accounts.mjs"
import { resolveStatePath } from "./paths.mjs"
import { loadPlaywright } from "./playwright-loader.mjs"
import { assertLoggedIn } from "./session-check.mjs"

/**
 * Zaimの連携口座を一括更新する（「データを更新する」を押す）。
 *
 * 連携口座は押すまで各金融機関から再取得されない。押さないまま巡回すると、
 * その日の資産額として古い残高が記録される（#62）。
 *
 * **完了のシグナルはZaim側に無い。** 口座ごとの「最終更新」が進んだかでしか判定できず、
 * 反映まで5〜15分かかる。さらに連携設定が壊れている口座（APIキーの権限エラー、
 * 金融機関側のログイン期限切れ）は何度押しても進まないため、全口座の完了を待つと
 * 必ず最大待ち時間まで粘ることになる。**しばらくどの口座も進まなくなったら打ち切る。**
 */

const PAGE_TIMEOUT = 60_000
const RENEWAL_FORM = 'form[action="/online_accounts/renewal"]'

/** 最終更新を読み直す間隔。 */
const POLL_INTERVAL_MS = 30_000
/** 押した直後は当然どこも進んでいない。この時間までは「進まない」を理由に打ち切らない。 */
const MIN_WAIT_MS = 5 * 60_000
/** どの口座も進まないまま続いたら打ち切る時間。 */
const QUIET_MS = 3 * 60_000
/** 上限。ここを超えたら更新できていない口座があっても諦める。 */
const DEFAULT_MAX_WAIT_MS = 15 * 60_000

function resolveMaxWaitMs() {
    const configured = Number(process.env.ZAIM_REFRESH_MAX_WAIT_MS)
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_WAIT_MS
}

/** 表示文字列をそのまま比べる。日時を解釈しなくても「進んだか」は分かる。 */
function mergeAccounts(before, current) {
    const previousByName = new Map(before.map((account) => [account.name, account.lastUpdatedAt]))
    return current.map((account) => {
        const previous = previousByName.get(account.name) ?? null
        return {
            name: account.name,
            lastUpdatedAt: account.lastUpdatedAt,
            previousLastUpdatedAt: previous,
            advanced: previous !== null && previous !== account.lastUpdatedAt,
        }
    })
}

// ボタンを押さずに、いま読めている口座と最終更新を出力するだけのモード。
// Zaimは連携先へ実際の取得を走らせるため、DOMの確認のたびに押さずに済むようにしてある。
const dryRun = process.env.ZAIM_REFRESH_DRY_RUN === "1"
const maxWaitMs = resolveMaxWaitMs()
const url = resolveOnlineAccountsUrl()

const { chromium } = await loadPlaywright()
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ storageState: resolveStatePath(), ...ZAIM_CONTEXT_OPTIONS })
const page = await context.newPage()

// ボタンには data-confirm によるネイティブ確認ダイアログが付いている。
// **Playwrightの既定は dismiss** なので、これを登録しないと押しても必ずキャンセルされる。
page.on("dialog", (dialog) => {
    dialog.accept().catch(() => {})
})

try {
    await page.goto(url, { waitUntil: "networkidle", timeout: PAGE_TIMEOUT })

    const button = page.locator(`${RENEWAL_FORM} button[type=submit]`).first()
    if ((await button.count()) === 0) {
        // ボタンが無いのは、ログイン画面へ飛ばされているか、Zaim側のDOMが変わったかのどちらか。
        // 前者は再ログインが要る失敗として区別したいので、先に判定する。
        await assertLoggedIn(page)
        throw new Error(`Zaimの「データを更新する」ボタンが見つかりません: ${url}`)
    }

    const before = await readOnlineAccounts(page)
    let accounts = mergeAccounts(before, before)
    let timedOut = false
    const startedAt = Date.now()

    if (!dryRun) {
        await button.click()
        // フォーム送信で画面が切り替わる。切り替わらない実装でも待ち続けないようにする。
        await page.waitForLoadState("networkidle", { timeout: PAGE_TIMEOUT }).catch(() => {})

        let advancedCount = 0
        let lastAdvancedAt = Date.now()

        while (Date.now() - startedAt < maxWaitMs) {
            await page.waitForTimeout(POLL_INTERVAL_MS)
            await page.goto(url, { waitUntil: "networkidle", timeout: PAGE_TIMEOUT })
            await assertLoggedIn(page)

            accounts = mergeAccounts(before, await readOnlineAccounts(page))

            const advanced = accounts.filter((account) => account.advanced).length
            if (advanced > advancedCount) {
                advancedCount = advanced
                lastAdvancedAt = Date.now()
            }

            // 全口座が進んだ＝更新完了。ここで抜けられるのは連携が全部健全なときだけ。
            if (accounts.length > 0 && advanced === accounts.length) break

            const elapsed = Date.now() - startedAt
            if (elapsed >= MIN_WAIT_MS && Date.now() - lastAdvancedAt >= QUIET_MS) break
        }

        timedOut =
            Date.now() - startedAt >= maxWaitMs &&
            accounts.some((account) => !account.advanced)
    }

    // 更新のたびに延長後のCookieを保存し直す。巡回・セッション維持と同じ扱い。
    await context.storageState({ path: resolveStatePath() })

    process.stdout.write(
        JSON.stringify({
            pressed: !dryRun,
            accounts,
            waitedMs: dryRun ? 0 : Date.now() - startedAt,
            timedOut,
        })
    )
} finally {
    await browser.close()
}
