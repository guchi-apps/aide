import { ZAIM_CONTEXT_OPTIONS } from "./context.mjs"
import { resolveStatePath } from "./paths.mjs"
import { loadPlaywright } from "./playwright-loader.mjs"
import {
    dateMatches,
    parseAmountValue,
    pickGenreIndex,
    readMenuItems,
    resolveReceiptEditUrl,
} from "./receipt-form.mjs"
import { assertLoggedIn } from "./session-check.mjs"

/**
 * Zaim Web版の編集画面（`/money/<moneyId>/edit`）から、既存明細（自動連携明細を含む）の
 * カテゴリ・内訳だけを変更する（#273）。
 *
 * **公式APIは自動連携明細（カード・スマートレシート等）を編集できない**（Zaim APIの仕様。
 * `write.ts` 冒頭）。asset-manager の「内訳の提案」（asset-manager#420）が算出した内訳を
 * 書き戻すため、この画面を人と同じように操作する。
 *
 * ## `web-payment.mjs`（新規登録）との違い
 *
 * - 開く画面が `/money/new` ではなく `/money/<moneyId>/edit`（既存の値が入った状態で開く）
 * - **触るのはカテゴリの入力欄だけ**。金額・日付・口座・品目・お店・集計対象外は
 *   フォームに残っている値をそのまま送る（触らない）
 * - **開いた明細が本文の `date`・`amount` と一致しなければ、カテゴリを触る前に止める。**
 *   別の明細を開いてしまった取り違えを、何も変えずに検知するため
 *
 * ## 黙って進まない
 *
 * `web-payment.mjs` と同じ方針。要素の不一致・確認の失敗はすべて例外にして保存の手前で止め、
 * 保存の直前に「カテゴリが実際に選び直せているか」を読み直す。
 *
 * ## 入出力
 *
 * 入力は環境変数 `ZAIM_WEB_GENRE_EDIT_INPUT`（JSON）。`ps` に金額やIDを出さないため。
 * 出力は stdout へJSON1本（`session.ts` の `runZaimScript()` がそのまま受け取る）。
 *
 * `dryRun` を立てると**保存だけを行わない**。取り違えの検知とカテゴリの選択までは行い、
 * 実際に選べた内容を返して終える。
 */

const PAGE_TIMEOUT = 60_000
/** 保存後に画面が変わるのを待つ上限。 */
const SUBMIT_TIMEOUT = 60_000
/** 入力のたびにReactの再描画を待つ。短すぎると読み直した値が古いまま通る。 */
const SETTLE_MS = 400

/**
 * **保存の前に**止まった失敗。Zaimには何も変更されていない。
 * マーカーの値は `errors.ts` の `ZAIM_RECEIPT_FORM` と同じ文字列である必要がある
 * （`web-payment.mjs` と共用のマーカー）。
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
    const raw = process.env.ZAIM_WEB_GENRE_EDIT_INPUT
    if (!raw) fail("ZAIM_WEB_GENRE_EDIT_INPUT が渡されていません")
    try {
        return JSON.parse(raw)
    } catch {
        fail("ZAIM_WEB_GENRE_EDIT_INPUT をJSONとして読めません")
    }
}

/** 1つだけ在るはずの要素を取る。0個でも2個以上でも、想定と違う画面とみなして止める。 */
async function only(locator, label) {
    const count = await locator.count()
    if (count !== 1) fail(`${label} が ${count} 個見つかりました（1個であるはずです）`)
    return locator.first()
}

/**
 * カテゴリを選び直す。`web-payment.mjs` の `selectGenre` と同じ画面部品を触る想定
 * （コンボボックスに名前で絞り込んで候補を選ぶ）。
 */
async function selectGenre(page, row, categoryName, genreName) {
    const combo = await only(row.locator("input:not([name])"), "カテゴリの入力欄")
    await combo.click()
    await combo.fill(genreName)
    await page.waitForTimeout(SETTLE_MS)

    const options = row.locator("ul li")
    const items = await options.evaluateAll(readMenuItems)
    const index = pickGenreIndex(items, categoryName, genreName)
    if (index < 0) {
        fail(
            `カテゴリ「${categoryName}」のジャンル「${genreName}」が候補に見つかりません` +
                `（候補 ${items.length} 件）。Zaimのカテゴリ設定と同じ名前を渡してください`
        )
    }

    await options.nth(index).click()
    await page.waitForTimeout(SETTLE_MS)

    const selected = await combo.inputValue()
    if (selected !== genreName) {
        fail(`カテゴリを選べませんでした（欄の値は「${selected}」で、期待は「${genreName}」）`)
    }
}

const input = readInput()
const dryRun = input.dryRun === true || process.env.ZAIM_WEB_GENRE_EDIT_DRY_RUN === "1"

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
    // 複数品目の明細はどの行を編集対象にするか決められないため、対象外として止める
    // （このIssueが対象にする自動連携明細は1明細1品目が前提）。
    if (rowCount !== 1) fail(`品目の行が ${rowCount} 個あります（1個であるはずです）`)
    const row = names.first().locator("xpath=ancestor::div[1]/parent::div")

    // ---- 取り違えの検知（カテゴリを触る前に行う） ----
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

    // ---- ここからカテゴリだけを触る ----
    await selectGenre(page, row, input.categoryName, input.genreName)

    // ---- 保存の直前に、触っていないはずの項目が変わっていないかを読み直す ----
    const filled = {
        genre: await row.locator("input:not([name])").first().inputValue(),
        amount: parseAmountValue(await amountField.inputValue()),
        date: await dateField.inputValue(),
    }
    if (filled.genre !== input.genreName) fail(`カテゴリが入っていません（欄の値は「${filled.genre}」）`)
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

        // **完了のシグナルはZaim側に無い。** 新規登録画面（`/money/new`）と違い、編集画面は
        // 保存後にフォームが空へ戻る目印を持たない（同じ明細の値が残ったままの可能性が高い）ため、
        // **URLが変わったこと**だけを完了の合図として見る。変わらなければ、変更されたかどうかを
        // 断定できない失敗として扱う（呼び出し元は記録を残したまま止まり、次の再送は conflict になる）。
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
