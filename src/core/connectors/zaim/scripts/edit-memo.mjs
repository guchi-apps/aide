import { ZAIM_CONTEXT_OPTIONS } from "./context.mjs"
import { resolveStatePath } from "./paths.mjs"
import { loadPlaywright } from "./playwright-loader.mjs"
import { dateMatches, parseAmountValue, resolveReceiptEditUrl } from "./receipt-form.mjs"
import { assertLoggedIn } from "./session-check.mjs"

/**
 * Zaim Web版の編集画面（`/money/<moneyId>/edit`）から、既存明細（自動連携明細を含む）の
 * **メモだけ**を書き換える（#354）。
 *
 * 銀行口座・デビットカードの連携明細はZaimの「置き換え」の対象外で、公式APIも自動連携明細を
 * 編集できない（`write.ts` 冒頭）。asset-manager の家計簿連携（asset-manager#514）が買った物を
 * メモへ直接書き込むため、この画面を人と同じように操作する。
 *
 * ## `edit-genre.mjs`（カテゴリの変更）との違い
 *
 * - 触るのは `input[name="comment"]` だけ。カテゴリ・金額・日付・口座・品目・お店・集計対象外は
 *   フォームに残っている値をそのまま送る
 * - 空文字の `comment` はメモを消す
 * - **`requestId` をメモへ混ぜない**（利用者が読むメモが汚れる。冪等は呼び出し側の記録で足りる）
 *
 * 開いた明細の取り違えの検知（`date`・`amount` が本文と一致しなければ、触る前に止める）・
 * 黙って進まない方針・入出力の形は `edit-genre.mjs` と同じ。
 *
 * ## 入出力
 *
 * 入力は環境変数 `ZAIM_WEB_MEMO_EDIT_INPUT`（JSON）。メモの本文や金額を `ps` に出さないため。
 * 出力は stdout へJSON1本。`dryRun`（または `ZAIM_WEB_MEMO_EDIT_DRY_RUN=1`）を立てると
 * **保存だけを行わない**。取り違えの検知とメモの入力までは行い、実際に入った内容を返して終える。
 */

const PAGE_TIMEOUT = 60_000
/** 保存後に画面が変わるのを待つ上限。 */
const SUBMIT_TIMEOUT = 60_000
/** 入力のたびにReactの再描画を待つ。短すぎると読み直した値が古いまま通る。 */
const SETTLE_MS = 400

/**
 * **保存の前に**止まった失敗。Zaimには何も変更されていない。
 * マーカーの値は `errors.ts` の `ZAIM_RECEIPT_FORM` と同じ文字列である必要がある。
 */
function fail(message) {
    throw new Error(`ZAIM_RECEIPT_FORM:${message}`)
}

/**
 * **保存した後で**分からなくなった失敗。変更された可能性が残る。
 * マーカーの値は `errors.ts` の `ZAIM_RECEIPT_SUBMITTED` と同じ文字列である必要がある。
 */
function failAfterSubmit(message) {
    throw new Error(`ZAIM_RECEIPT_SUBMITTED:${message}`)
}

function readInput() {
    const raw = process.env.ZAIM_WEB_MEMO_EDIT_INPUT
    if (!raw) fail("ZAIM_WEB_MEMO_EDIT_INPUT が渡されていません")
    try {
        return JSON.parse(raw)
    } catch {
        fail("ZAIM_WEB_MEMO_EDIT_INPUT をJSONとして読めません")
    }
}

/** 1つだけ在るはずの要素を取る。0個でも2個以上でも、想定と違う画面とみなして止める。 */
async function only(locator, label) {
    const count = await locator.count()
    if (count !== 1) fail(`${label} が ${count} 個見つかりました（1個であるはずです）`)
    return locator.first()
}

const input = readInput()
// 空文字は「メモを消す」ので許す。文字列でなければ、消すつもりのない誤送信として止める。
if (typeof input.comment !== "string") fail("comment が文字列ではありません")
const dryRun = input.dryRun === true || process.env.ZAIM_WEB_MEMO_EDIT_DRY_RUN === "1"

const url = resolveReceiptEditUrl(input.moneyId)
const statePath = resolveStatePath()

const { chromium } = await loadPlaywright()
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ storageState: statePath, ...ZAIM_CONTEXT_OPTIONS })
const page = await context.newPage()

try {
    await page.goto(url, { waitUntil: "networkidle", timeout: PAGE_TIMEOUT })
    // フォームが無い理由の大半はログイン画面へ飛ばされたこと。先にそちらとして判定する。
    await assertLoggedIn(page)

    const form = page.locator(process.env.ZAIM_RECEIPT_EDIT_FORM_SELECTOR || "#money_edit_form")
    if ((await form.count()) === 0) fail(`編集フォームが見つかりません: ${url}`)

    const names = form.locator('input[name="item_name"]')
    const rowCount = await names.count()
    // 複数品目の明細はどの行のメモを書き換えるか決められないため、対象外として止める
    // （このIssueが対象にする自動連携明細は1明細1品目が前提）。
    if (rowCount !== 1) fail(`品目の行が ${rowCount} 個あります（1個であるはずです）`)
    const row = names.first().locator("xpath=ancestor::div[1]/parent::div")

    // ---- 取り違えの検知（メモを触る前に行う） ----
    const dateField = await only(form.locator('input[name="date"]'), "日付の入力欄")
    const dateValue = await dateField.inputValue()
    if (!dateMatches(dateValue, input.date)) {
        fail(
            `開いた明細の日付が一致しません（期待 ${input.date}、実際「${dateValue}」）。` +
                "別の明細を開いた可能性があります"
        )
    }

    const amountField = await only(row.locator('input[name="amount"]'), "金額の入力欄")
    const amountValue = parseAmountValue(await amountField.inputValue())
    if (amountValue !== input.amount) {
        fail(
            `開いた明細の金額が一致しません（期待 ${input.amount}、実際 ${amountValue}）。` +
                "別の明細を開いた可能性があります"
        )
    }

    // ---- ここからメモだけを触る ----
    const commentField = await only(row.locator('input[name="comment"]'), "メモの入力欄")
    await commentField.fill(input.comment)
    await page.waitForTimeout(SETTLE_MS)

    // ---- 保存の直前に、メモが入り、触っていないはずの項目が変わっていないかを読み直す ----
    const filled = {
        comment: await commentField.inputValue(),
        amount: parseAmountValue(await amountField.inputValue()),
        date: await dateField.inputValue(),
    }
    if (filled.comment !== input.comment) fail("メモが入っていません（欄の値が期待と違います）")
    if (filled.amount !== input.amount) {
        fail(`金額が変わっています（欄の値は ${filled.amount}、期待は ${input.amount}）`)
    }
    if (!dateMatches(filled.date, input.date)) {
        fail(`日付が変わっています（欄の値は「${filled.date}」）`)
    }

    if (dryRun) {
        // Cookieの延長は保存しなくても効く。巡回・新規登録と同じく保存し直す。
        await context.storageState({ path: statePath })
        process.stdout.write(JSON.stringify({ submitted: false, url, filled }))
    } else {
        const submit = await only(form.locator('input[type="submit"]'), "保存ボタン")
        const before = page.url()
        await submit.click()

        // 完了のシグナルはZaim側に無く、`edit-genre.mjs` と同じく**URLが変わったこと**だけを
        // 完了の合図として見る。変わらなければ、変更されたかどうかを断定できない失敗として扱う。
        await page
            .waitForFunction(({ before: previous }) => location.href !== previous, { before }, { timeout: SUBMIT_TIMEOUT })
            .catch(() => {
                failAfterSubmit("保存しましたが、画面が変わったことを確認できませんでした")
            })
        await page.waitForLoadState("networkidle", { timeout: PAGE_TIMEOUT }).catch(() => {})

        await context.storageState({ path: statePath })
        process.stdout.write(
            JSON.stringify({ submitted: true, url, resultUrl: page.url(), filled })
        )
    }
} finally {
    await browser.close()
}
