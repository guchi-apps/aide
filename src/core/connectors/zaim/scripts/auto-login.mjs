import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { resolveStatePath } from "./paths.mjs"
import { loadPlaywright } from "./playwright-loader.mjs"

/**
 * ID・パスワードによる自動ログイン。storage state を保存し直す。
 *
 * `login.mjs`（GUIのある端末で人が手でログインする。`headless: false`）とは別物で、
 * こちらはサブPCのworkerからヘッドレスで走る。セッションが失効したとき、GUI端末での
 * 手動ログインを待たずに復旧するためにある（#63）。
 *
 * ## 前提と限界
 *
 * - `ZAIM_EMAIL` / `ZAIM_PASSWORD` が両方設定されているときだけ動く。**未設定なら何もしない。**
 *   資格情報を置きたくない環境では従来どおり手動ログインへ倒す
 * - **CAPTCHA・2要素認証が出たら突破しにいかない。** 検知できたら素直に失敗する。
 *   呼び出し側（`session.ts`）は失敗を受けて元の `ZAIM_SESSION_EXPIRED` を投げ直すため、
 *   通知は従来どおり「手動ログインが必要」として届く
 * - Zaimのログインは `id.kufu.jp` のSSO画面へ飛ぶ。画面構成は変わりうるため、
 *   セレクタは環境変数で上書きできるようにしてある
 *
 * **資格情報をログへ出さないこと。** 例外メッセージにも載せない。
 */

const NAVIGATION_TIMEOUT_MS = 60_000
const FIELD_TIMEOUT_MS = 20_000
const SIGN_IN_TIMEOUT_MS = 60_000

/** メールアドレス欄の候補。上から順に試す。 */
const EMAIL_SELECTORS = [
    'input[type="email"]',
    'input[name="email"]',
    'input[name="username"]',
    'input[name="login"]',
    'input[autocomplete="username"]',
]

const PASSWORD_SELECTORS = ['input[type="password"]', 'input[name="password"]']

const SUBMIT_SELECTORS = ['button[type="submit"]', 'input[type="submit"]', "form button"]

/** 突破しにいかない追加認証を、画面の文言から検知するための語。 */
const EXTRA_AUTH_PATTERNS = /認証コード|ワンタイム|二段階|2段階|二要素|画像の文字|reCAPTCHA/i

/** ログインできたかの判定に使う、残高画面にだけ出る語。 */
const SIGNED_IN_PATTERNS = /残高|総残高|評価額/

const email = process.env.ZAIM_EMAIL?.trim()
const password = process.env.ZAIM_PASSWORD?.trim()
const loginUrl = process.env.ZAIM_LOGIN_URL || "https://zaim.net/"
const balanceUrl = process.env.ZAIM_BALANCE_URL || "https://zaim.net/home"
const statePath = resolveStatePath()

// 片方だけの設定は設定漏れ。中途半端に試さず、何もせず失敗させる。
if (!email || !password) {
    console.error("自動ログインは未設定です（ZAIM_EMAIL / ZAIM_PASSWORD の両方が要ります）")
    process.exit(1)
}

/** 候補を順に試し、最初に見つかった要素を返す。無ければ null。 */
async function findFirst(page, selectors, timeoutMs) {
    const configured = selectors.configured
    const candidates = configured ? [configured] : selectors.defaults

    for (const selector of candidates) {
        const locator = page.locator(selector).first()
        try {
            await locator.waitFor({ state: "visible", timeout: timeoutMs })
            return locator
        } catch {
            // 次の候補へ。画面によって name 属性が違うため、見つからないのは普通のこと。
        }
    }
    return null
}

/**
 * ログインしきれなかったときの理由を、画面の文言から一段具体的にする。
 *
 * **突破を試みるための判定ではない。** 追加認証で止まったのか、認証情報が違うのかで
 * 人がやることが変わるため、通知に載る一行を分けているだけ。
 * ログイン画面のヘルプリンクに引っかかることがあるので、**判定は失敗が確定した後にだけ行う**
 * （途中で見ると、正常にログインできる場合まで止めてしまう）。
 */
function describeSignInFailure(bodyText) {
    if (EXTRA_AUTH_PATTERNS.test(bodyText)) {
        return "追加認証（2要素・CAPTCHA等）が要求されました。手動でログインし直してください。"
    }
    // URLには login_challenge のような識別子が載るため、メッセージに含めない。
    return "ログイン後に残高ページを開けませんでした。認証情報が正しいか確認してください。"
}

const { chromium } = await loadPlaywright()

await mkdir(dirname(statePath), { recursive: true })

// 失効したCookieを引き継ぐと、ログイン画面へ飛ばずに中途半端な状態になることがある。
// 保存済みの状態は読み込まず、まっさらな状態からログインし直す。
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext()
const page = await context.newPage()

try {
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS })

    // トップページにログインフォームが無い場合は、残高ページを開いてSSOへ飛ばす。
    let emailField = await findFirst(
        page,
        { configured: process.env.ZAIM_LOGIN_EMAIL_SELECTOR, defaults: EMAIL_SELECTORS },
        5_000,
    )
    if (!emailField) {
        await page.goto(balanceUrl, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS })
        emailField = await findFirst(
            page,
            { configured: process.env.ZAIM_LOGIN_EMAIL_SELECTOR, defaults: EMAIL_SELECTORS },
            FIELD_TIMEOUT_MS,
        )
    }

    if (!emailField) {
        throw new Error(
            "ログインフォームのメールアドレス欄が見つかりませんでした。" +
                "ZAIM_LOGIN_EMAIL_SELECTOR で指定してください。",
        )
    }

    await emailField.fill(email)

    // メールアドレスとパスワードが別画面に分かれるSSOがあるため、
    // パスワード欄がまだ無ければ一度送信して次の画面へ進む。
    let passwordField = await findFirst(
        page,
        { configured: process.env.ZAIM_LOGIN_PASSWORD_SELECTOR, defaults: PASSWORD_SELECTORS },
        2_000,
    )
    if (!passwordField) {
        const next = await findFirst(
            page,
            { configured: process.env.ZAIM_LOGIN_SUBMIT_SELECTOR, defaults: SUBMIT_SELECTORS },
            FIELD_TIMEOUT_MS,
        )
        if (!next) throw new Error("ログインフォームの送信ボタンが見つかりませんでした。")
        await next.click()
        passwordField = await findFirst(
            page,
            { configured: process.env.ZAIM_LOGIN_PASSWORD_SELECTOR, defaults: PASSWORD_SELECTORS },
            FIELD_TIMEOUT_MS,
        )
    }

    if (!passwordField) {
        throw new Error(
            "ログインフォームのパスワード欄が見つかりませんでした。" +
                "ZAIM_LOGIN_PASSWORD_SELECTOR で指定してください。",
        )
    }

    await passwordField.fill(password)

    const submit = await findFirst(
        page,
        { configured: process.env.ZAIM_LOGIN_SUBMIT_SELECTOR, defaults: SUBMIT_SELECTORS },
        FIELD_TIMEOUT_MS,
    )
    if (!submit) throw new Error("ログインフォームの送信ボタンが見つかりませんでした。")
    await submit.click()

    // 遷移先はSSOの戻り先で一定しない。ログインできたかは
    // 「残高ページを開けるか」で判定する（login.mjs と同じ考え方）。
    await page.waitForLoadState("domcontentloaded", { timeout: SIGN_IN_TIMEOUT_MS })

    await page.goto(balanceUrl, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS })
    const bodyText = (await page.locator("body").innerText()).replace(/\s+/g, " ")
    if (!SIGNED_IN_PATTERNS.test(bodyText)) {
        throw new Error(describeSignInFailure(bodyText))
    }

    await context.storageState({ path: statePath })
    console.log("✅ Zaimへ自動ログインし、ログイン状態を保存しました")
} catch (error) {
    // error はPlaywrightの例外で、入力値そのものは含まない（fill の値はログに出ない）。
    console.error("❌ Zaimへの自動ログインに失敗しました", error instanceof Error ? error.message : error)
    process.exitCode = 1
} finally {
    await browser.close()
}
