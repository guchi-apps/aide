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
import { dateMatches, parseAmountValue } from "./receipt-form.mjs"

/**
 * Zaim Web版の「家計簿の編集」モーダルから、既存明細（自動連携明細を含む）の
 * **メモだけ**を書き換える（#354・#409）。
 *
 * 銀行口座・デビットカードの連携明細はZaimの「置き換え」の対象外で、公式APIも自動連携明細を
 * 編集できない（`write.ts` 冒頭）。asset-manager の家計簿連携（asset-manager#514）が買った物を
 * メモへ直接書き込むため、この画面を人と同じように操作する。
 *
 * **編集UIは `/money/<moneyId>/edit` ではなく、一覧（`/money?month=YYYYMM`）の鉛筆アイコンから
 * 開くモーダルにある**（#409）。開き方・行の選び方・「更新する」の押し方は
 * `edit-modal.mjs`（`edit-genre.mjs` と共通）を参照。
 *
 * ## `edit-genre.mjs`（カテゴリの変更）との違い
 *
 * - 触るのは `input[name="comment"]` だけ。カテゴリ・金額・日付・口座・品目・お店・集計対象外は
 *   モーダルに残っている値をそのまま送る
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
 * **「更新する」だけを押さない**。取り違えの検知とメモの入力までは行い、実際に入った内容を返して終える。
 */

function readInput() {
    const raw = process.env.ZAIM_WEB_MEMO_EDIT_INPUT
    if (!raw) fail("ZAIM_WEB_MEMO_EDIT_INPUT が渡されていません")
    try {
        return JSON.parse(raw)
    } catch {
        fail("ZAIM_WEB_MEMO_EDIT_INPUT をJSONとして読めません")
    }
}

const input = readInput()
// 空文字は「メモを消す」ので許す。文字列でなければ、消すつもりのない誤送信として止める。
if (typeof input.comment !== "string") fail("comment が文字列ではありません")
const dryRun = input.dryRun === true || process.env.ZAIM_WEB_MEMO_EDIT_DRY_RUN === "1"

const statePath = resolveStatePath()

const { chromium } = await loadPlaywright()
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ storageState: statePath, ...ZAIM_CONTEXT_OPTIONS })
const page = await context.newPage()

try {
    const url = await openEditModal(page, { moneyId: input.moneyId, date: input.date })
    const { row, amountField } = await pickModalRow(page)

    // ---- 取り違えの検知（メモを触る前に行う） ----
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

    // ---- ここからメモだけを触る ----
    const commentField = await only(row.locator('input[name="comment"]'), "メモの入力欄")
    await commentField.fill(input.comment)
    await page.waitForTimeout(SETTLE_MS)

    // ---- 更新の直前に、メモが入り、触っていないはずの項目が変わっていないかを読み直す ----
    const filled = {
        comment: await commentField.inputValue(),
        amount: parseAmountValue(await amountField.inputValue()),
        date: await date.inputValue(),
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
        await submitEditModal(page)

        // モーダルが閉じただけでは更新が通ったと言えない。一覧を開き直し、その明細の行に
        // 表示されているメモが書いた値と一致することまで確かめる。
        const listed = await readListedRow(page, { moneyId: input.moneyId, date: input.date })
        if (listed.comment !== input.comment.replace(/\s+/g, " ").trim()) {
            failAfterSubmit("更新しましたが、一覧に表示されているメモが書いた内容と一致しません")
        }

        await context.storageState({ path: statePath })
        process.stdout.write(JSON.stringify({ submitted: true, url, resultUrl: page.url(), filled }))
    }
} finally {
    await browser.close()
}
