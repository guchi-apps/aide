import { ZAIM_CONTEXT_OPTIONS } from "./context.mjs"
import {
    SETTLE_MS,
    dateField,
    fail,
    failAfterSubmit,
    only,
    openEditModal,
    pickModalRow,
    readListedRow,
    submitEditModal,
} from "./edit-modal.mjs"
import { resolveStatePath } from "./paths.mjs"
import { loadPlaywright } from "./playwright-loader.mjs"
import { dateMatches, parseAmountValue, pickGenreIndex, readMenuItems } from "./receipt-form.mjs"

/**
 * Zaim Web版の「家計簿の編集」モーダルから、既存明細（自動連携明細を含む）の
 * カテゴリ・内訳だけを変更する（#273・#409）。
 *
 * **公式APIは自動連携明細（カード・スマートレシート等）を編集できない**（Zaim APIの仕様。
 * `write.ts` 冒頭）。asset-manager の「内訳の提案」（asset-manager#420）が算出した内訳を
 * 書き戻すため、この画面を人と同じように操作する。
 *
 * ## `web-payment.mjs`（新規登録）との違い
 *
 * - 開く画面が `/money/new` ではなく、一覧（`/money?month=YYYYMM`）の鉛筆アイコンから開く
 *   「家計簿の編集」モーダル（既存の値が入った状態で開く）。**`/money/<moneyId>/edit` を直接
 *   開いても編集UIは出ない**（#409）。開き方・行の選び方・「更新する」の押し方は
 *   `edit-modal.mjs`（`edit-memo.mjs` と共通）を参照
 * - **触るのはカテゴリの入力欄だけ**。金額・日付・口座・品目・お店・集計対象外は
 *   モーダルに残っている値をそのまま送る（触らない）
 * - **開いた明細が本文の `date`・`amount` と一致しなければ、カテゴリを触る前に止める。**
 *   別の明細を開いてしまった取り違えを、何も変えずに検知するため
 *
 * ## 黙って進まない
 *
 * `web-payment.mjs` と同じ方針。要素の不一致・確認の失敗はすべて例外にして保存の手前で止め、
 * 更新の直前に「カテゴリが実際に選び直せているか」を読み直す。
 *
 * ## 入出力
 *
 * 入力は環境変数 `ZAIM_WEB_GENRE_EDIT_INPUT`（JSON）。`ps` に金額やIDを出さないため。
 * 出力は stdout へJSON1本（`session.ts` の `runZaimScript()` がそのまま受け取る）。
 *
 * `dryRun` を立てると**「更新する」だけを押さない**。取り違えの検知とカテゴリの選択までは行い、
 * 実際に選べた内容を返して終える。
 */

function readInput() {
    const raw = process.env.ZAIM_WEB_GENRE_EDIT_INPUT
    if (!raw) fail("ZAIM_WEB_GENRE_EDIT_INPUT が渡されていません")
    try {
        return JSON.parse(raw)
    } catch {
        fail("ZAIM_WEB_GENRE_EDIT_INPUT をJSONとして読めません")
    }
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

const statePath = resolveStatePath()

const { chromium } = await loadPlaywright()
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ storageState: statePath, ...ZAIM_CONTEXT_OPTIONS })
const page = await context.newPage()

try {
    const url = await openEditModal(page, { moneyId: input.moneyId, date: input.date })
    const { row, amountField } = await pickModalRow(page)

    // ---- 取り違えの検知（カテゴリを触る前に行う） ----
    const date = await dateField(page)
    const dateValue = await date.inputValue()
    if (!dateMatches(dateValue, input.date)) {
        fail(
            `開いた明細の日付が一致しません（期待 ${input.date}、実際「${dateValue}」）。` +
                "別の明細を開いた可能性があります"
        )
    }

    const amountValue = parseAmountValue(await amountField.inputValue())
    if (amountValue !== input.amount) {
        fail(
            `開いた明細の金額が一致しません（期待 ${input.amount}、実際 ${amountValue}）。` +
                "別の明細を開いた可能性があります"
        )
    }

    // ---- ここからカテゴリだけを触る ----
    await selectGenre(page, row, input.categoryName, input.genreName)

    // ---- 更新の直前に、触っていないはずの項目が変わっていないかを読み直す ----
    const filled = {
        genre: await row.locator("input:not([name])").first().inputValue(),
        amount: parseAmountValue(await amountField.inputValue()),
        date: await date.inputValue(),
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
        await submitEditModal(page)

        // モーダルが閉じただけでは更新が通ったと言えない。一覧を開き直し、その明細の行に
        // 表示されているカテゴリ・内訳が選んだ値と一致することまで確かめる。
        const listed = await readListedRow(page, { moneyId: input.moneyId, date: input.date })
        if (listed.category !== input.categoryName || listed.genre !== input.genreName) {
            failAfterSubmit("更新しましたが、一覧に表示されているカテゴリ・内訳が選んだ内容と一致しません")
        }

        await context.storageState({ path: statePath })
        process.stdout.write(JSON.stringify({ submitted: true, url, resultUrl: page.url(), filled }))
    }
} finally {
    await browser.close()
}
