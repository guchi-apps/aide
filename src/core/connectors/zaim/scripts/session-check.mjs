/**
 * ログイン状態の確認。
 *
 * Zaimは未ログインでもエラーにせずログイン画面を返すため、HTTPステータスでは判別できない。
 * 画面の文言で見分け、失効していたら `ZAIM_SESSION_EXPIRED` を投げる。
 * このマーカーを落とすと、通知側（src/worker/notify.ts）が「手動ログインをやり直すまで
 * 直らない失敗」だと判別できなくなる。
 */
export async function assertLoggedIn(page) {
    const bodyText = (await page.locator("body").innerText()).replace(/\s+/g, " ").trim()
    if (/ログイン|メールアドレス|パスワード/.test(bodyText) && !/残高|総残高|評価額/.test(bodyText)) {
        throw new Error(`ZAIM_SESSION_EXPIRED:${page.url()}`)
    }
}
