/**
 * ログイン状態の確認。
 *
 * Zaimは未ログインでもエラーにせず、SSO（`id.kufu.jp`）のログイン画面へ飛ばすため、
 * HTTPステータスでは判別できない。**飛ばされたかどうか**で見分け、失効していたら
 * `ZAIM_SESSION_EXPIRED` を投げる。このマーカーを落とすと、通知側（src/worker/notify.ts）が
 * 「手動ログインをやり直すまで直らない失敗」だと判別できなくなる。
 *
 * 以前は本文に「ログイン／メールアドレス／パスワード」が含まれ、かつ「残高／総残高／評価額」が
 * 含まれないことを失効の条件にしていた。**残高を載せないページでは正常でも失効と誤判定する。**
 * 実際、連携口座一覧（`/online_accounts`）は本文に「ログイン」（連携先へのログインの説明）を
 * 含み金額を載せないため、`zaim-refresh` はボタンを押した直後の確認で必ず失敗し、
 * 「手動ログインが必要」という誤った通知だけが届いていた（#89）。
 */

/** 失効時の飛び先。ZaimのログインはSSO（`id.kufu.jp`）が担う。 */
const LOGIN_URL = /:\/\/([^/]+\.)?id\.kufu\.jp(\/|$)/

/** ログイン画面の目印。ログイン画面がZaim側のドメインで返る場合に備えて併用する。 */
const PASSWORD_FIELD = 'input[type="password"]'

export async function assertLoggedIn(page) {
    const url = page.url()
    // URLだけで分かる場合はDOMを読まない。ログイン画面はSSOへのリダイレクトで届く。
    if (LOGIN_URL.test(url)) {
        throw new Error(`ZAIM_SESSION_EXPIRED:${url}`)
    }
    if ((await page.locator(PASSWORD_FIELD).count()) > 0) {
        throw new Error(`ZAIM_SESSION_EXPIRED:${url}`)
    }
}
