import { createInterface } from "node:readline/promises"
import { authorizationHeader, normalizeParams } from "../oauth.ts"

/**
 * Zaim APIのアクセストークンを取得する（aide#37）。**1回だけ人が実行する。**
 *
 * OAuth 1.0a の3-legged フローはブラウザでの認可が要るため、サーバーの実行時には行わない。
 * ここで取った access token / secret を `.env` と 1Password に置き、実行時はそれを読むだけにする。
 *
 * GUIの無いサブPCで実行してよい。認可の画面は手元のPCのブラウザで開き、
 * 戻り先URLに付く `oauth_verifier` をこの画面へ貼り付ける。
 *
 *   AIDE_ZAIM_CONSUMER_KEY=xxx AIDE_ZAIM_CONSUMER_SECRET=yyy \
 *     node src/core/connectors/zaim/scripts/oauth-token.mjs
 *
 * consumer key / secret は https://dev.zaim.net/ でアプリを登録すると発行される。
 * 登録時のコールバックURLは何でもよい（この手順では戻り先を開く必要が無い）。
 */

const REQUEST_TOKEN_URL = "https://api.zaim.net/v2/auth/request"
const AUTHORIZE_URL = "https://auth.zaim.net/users/auth"
const ACCESS_TOKEN_URL = "https://api.zaim.net/v2/auth/access"

/** Zaimはこの3つのエンドポイントだけ、JSONではなくフォーム形式（`a=1&b=2`）で返す。 */
function parseFormResponse(text) {
    const params = new URLSearchParams(text)
    const token = params.get("oauth_token")
    const secret = params.get("oauth_token_secret")
    if (!token || !secret) {
        throw new Error(`応答からトークンを読めませんでした: ${text.slice(0, 200)}`)
    }
    return { token, secret }
}

async function post(url, credentials, params) {
    const res = await fetch(url, {
        method: "POST",
        headers: {
            authorization: authorizationHeader(credentials, "POST", url, params),
            "content-type": "application/x-www-form-urlencoded",
        },
        body: normalizeParams(params),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
    return parseFormResponse(text)
}

/** 認可後の戻り先URLごと貼られても拾えるようにする（手で切り出させると間違いやすい）。 */
function extractVerifier(input) {
    const trimmed = input.trim()
    if (!trimmed) return ""
    try {
        return new URL(trimmed).searchParams.get("oauth_verifier") ?? ""
    } catch {
        return trimmed
    }
}

async function main() {
    const consumerKey = process.env.AIDE_ZAIM_CONSUMER_KEY
    const consumerSecret = process.env.AIDE_ZAIM_CONSUMER_SECRET
    if (!consumerKey || !consumerSecret) {
        console.error("AIDE_ZAIM_CONSUMER_KEY と AIDE_ZAIM_CONSUMER_SECRET を設定して実行してください。")
        console.error("値は https://dev.zaim.net/ でアプリを登録すると発行されます。")
        process.exit(1)
    }

    // リクエストトークンの段階では、まだユーザーのトークンが無い（空で署名する）。
    const base = { consumerKey, consumerSecret, accessToken: "", accessTokenSecret: "" }
    const request = await post(REQUEST_TOKEN_URL, base, { oauth_callback: "oob" })

    console.log("\n1. 手元のPCのブラウザで次のURLを開き、連携を許可してください。\n")
    console.log(`   ${AUTHORIZE_URL}?oauth_token=${encodeURIComponent(request.token)}\n`)
    console.log("2. 許可すると戻り先URLへ飛びます。そのURL（または画面に出た oauth_verifier）を貼り付けてください。")
    console.log("   ※ 戻り先が開けない状態でも、アドレスバーのURLをコピーすれば足ります。\n")

    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const verifier = extractVerifier(await rl.question("oauth_verifier: "))
    rl.close()
    if (!verifier) {
        console.error("oauth_verifier が空です。中断しました。")
        process.exit(1)
    }

    const access = await post(
        ACCESS_TOKEN_URL,
        { consumerKey, consumerSecret, accessToken: request.token, accessTokenSecret: request.secret },
        { oauth_verifier: verifier },
    )

    // **この2つはパスワードと同じ扱い。** Issueコメント・PR・ログへ貼らないこと。
    console.log("\n取得しました。次の2つを 1Password（op://apps/aide/zaim-access-token /")
    console.log("zaim-access-token-secret）と本番の .env・GitHubのsecretへ登録してください。\n")
    console.log(`AIDE_ZAIM_ACCESS_TOKEN=${access.token}`)
    console.log(`AIDE_ZAIM_ACCESS_TOKEN_SECRET=${access.secret}`)
    console.log("\n※ 画面に出た値はどこにも貼り付けず、登録が済んだら端末の履歴も流してください。")
}

await main()
