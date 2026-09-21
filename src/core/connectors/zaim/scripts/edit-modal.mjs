import {
    parseAmountValue,
    pickFilledRowIndex,
    receiptEditTriggerSelector,
    resolveReceiptListUrl,
} from "./receipt-form.mjs"
import { assertLoggedIn } from "./session-check.mjs"

/**
 * Zaim Web版の「家計簿の編集」モーダルを開いて操作するための共通部品（#409）。
 * `edit-memo.mjs`（#354）と `edit-genre.mjs`（#273）が使う。
 *
 * ## 編集UIは `/money/<moneyId>/edit` ではなく、一覧のモーダルにある
 *
 * **実物で確かめた**（2026-09-21・#410）。`/money/<moneyId>/edit` を直接開くと、通常のブラウザでも
 * 画面は真っ白で入力欄が無い（`$ is not defined`・`receipt_edit.tsx` の描画失敗）。ページに
 * 在る `#edit-receipt-form` は hidden の `utf8`・`_method=put`・`receipt[receipt_id]` だけで、
 * 送信先は `/receipts/<moneyId>`。**これを直接送ると画面の送信内容と一致する保証が無い**うえ、
 * `Receipt` はレシート単位で `items` を持つため、レシート内の全明細を置き換えてしまう恐れがある
 * ので、**採用しない**。
 *
 * 編集UIは `/money?month=YYYYMM` の一覧で、行の鉛筆アイコン（`data-url="/money/<moneyId>/edit"`。
 * `a[href]` ではない）を押すと開くモーダルにだけ在る。モーダルは品目の行（品目名・カテゴリ・
 * 金額・メモ・行削除×）が複数行、合計金額・出金元・全体のカテゴリ・日付・お店・集計の欄、
 * 「削除する」「更新する」のボタンを持つ。**ボタンは `<form>` に属さない**（`formAction` が
 * 一覧のURLになる）ので、更新は画面のJSが送っている。だから人と同じく「更新する」を押す。
 *
 * **モーダル内の入力欄の `name` は、新規登録画面（`receipt-form.mjs`）と同じだと仮定している**
 * （`item_name`・`amount`・`comment`・`date`）。実物のモーダルでは未確認なので、当たらなければ
 * 保存の手前で `describeScreen()` の内容（要素名・ボタン名だけ。値は含めない）を添えて止まる。
 */

const PAGE_TIMEOUT = 60_000
/** 鉛筆アイコンを押してからモーダルが描画されるのを待つ上限。 */
const MODAL_TIMEOUT = 20_000
/** 更新を押した後にモーダルが閉じるのを待つ上限。 */
const SUBMIT_TIMEOUT = 60_000
/** 入力のたびにReactの再描画を待つ。短すぎると読み直した値が古いまま通る。 */
export const SETTLE_MS = 400

const ITEM_NAME_FIELD = 'input[name="item_name"]'
/** 「削除する」が隣に並ぶ。**完全一致**で当てる（部分一致や位置で当てない）。 */
const UPDATE_BUTTON_NAME = "更新する"

/**
 * **保存の前に**止まった失敗。Zaimには何も変更されていない。
 * マーカーの値は `errors.ts` の `ZAIM_RECEIPT_FORM` と同じ文字列である必要がある。
 */
export function fail(message) {
    throw new Error(`ZAIM_RECEIPT_FORM:${message}`)
}

/**
 * **保存した後で**分からなくなった失敗。変更された可能性が残る。
 * マーカーの値は `errors.ts` の `ZAIM_RECEIPT_SUBMITTED` と同じ文字列である必要がある。
 */
export function failAfterSubmit(message) {
    throw new Error(`ZAIM_RECEIPT_SUBMITTED:${message}`)
}

/** 1つだけ在るはずの要素を取る。0個でも2個以上でも、想定と違う画面とみなして止める。 */
export async function only(locator, label) {
    const count = await locator.count()
    if (count !== 1) fail(`${label} が ${count} 個見つかりました（1個であるはずです）`)
    return locator.first()
}

/**
 * 画面の構造の要約。**想定と違う画面で止まるとき、次の手がかりを1回の実行で得るために**
 * 失敗メッセージへ添える。
 *
 * 出すのは入力欄の種類と `name`・ボタンの文言・パスだけ。**値（金額・メモ・Cookie・トークン）は
 * 読まない**（ログや通知に残っても構わない粒度に留める）。
 */
export async function describeScreen(page) {
    const summary = await page.evaluate(() => {
        const count = new Map()
        for (const el of document.querySelectorAll("input, select, textarea")) {
            const tag = el.tagName.toLowerCase()
            const kind = tag === "input" ? `input[${el.type}]` : tag
            const key = el.name ? `${kind}:${el.name}` : kind
            count.set(key, (count.get(key) ?? 0) + 1)
        }
        const buttons = new Set()
        for (const el of document.querySelectorAll('button, input[type="submit"]')) {
            const text = (el.textContent?.trim() || el.value || "").replace(/\s+/g, " ")
            buttons.add(text ? text.slice(0, 20) : "(文言なし)")
        }
        return {
            path: location.pathname + location.search,
            fields: [...count].slice(0, 40).map(([key, n]) => (n > 1 ? `${key}×${n}` : key)),
            buttons: [...buttons].slice(0, 20),
        }
    })
    return `画面 ${summary.path} / 入力欄 ${summary.fields.join(", ") || "なし"} / ボタン ${summary.buttons.join(", ") || "なし"}`
}

/** 想定と違う画面として、画面の要約を添えて止める。 */
async function failScreen(page, message) {
    fail(`${message}。${await describeScreen(page)}`)
}

/** 開いている編集モーダル（の品目名の欄）が1つも見えていないか。 */
function noVisibleModal() {
    return [...document.querySelectorAll('input[name="item_name"]')].every((el) => el.offsetParent === null)
}

/**
 * 一覧を開き、`moneyId` の明細の鉛筆アイコンを押して、編集モーダルを描画させる。
 *
 * @returns 一覧のURL（出力へ載せる）
 */
export async function openEditModal(page, { moneyId, date }) {
    const listUrl = resolveReceiptListUrl(date)
    await page.goto(listUrl, { waitUntil: "networkidle", timeout: PAGE_TIMEOUT })
    // 要素が無い理由の大半はログイン画面へ飛ばされたこと。先にそちらとして判定する。
    await assertLoggedIn(page)

    // 開く前からモーダルが出ていたら、いま見えているものが自分の開いた明細だと言えない。
    if (!(await page.evaluate(noVisibleModal))) fail("一覧を開いた時点で編集の入力欄が既に出ています")

    // 鉛筆アイコンとそれを含む行の両方が同じ `data-url` を持つ作りでも、どれを押しても
    // 同じ明細のモーダルが開く。見えている最後（＝いちばん内側）のものを押す。
    const triggers = page.locator(`${receiptEditTriggerSelector(moneyId)} >> visible=true`)
    if ((await triggers.count()) === 0) {
        await failScreen(page, `一覧に明細 ${moneyId} の編集を開く要素が見つかりません（${listUrl}）`)
    }
    await triggers.last().click({ timeout: MODAL_TIMEOUT })

    await page
        .locator(ITEM_NAME_FIELD)
        .first()
        .waitFor({ state: "visible", timeout: MODAL_TIMEOUT })
        .catch(async () => {
            await failScreen(page, "編集を開く要素を押しましたが、編集の入力欄が描画されませんでした")
        })
    // モーダルの中身は非同期で埋まる。値が入る前に読まないよう、落ち着くのを待つ。
    await page.waitForLoadState("networkidle", { timeout: PAGE_TIMEOUT }).catch(() => {})
    await page.waitForTimeout(SETTLE_MS)

    return listUrl
}

/**
 * モーダルの品目の行のうち、書き換える行を返す。金額が入っている行がちょうど1つのときだけ
 * 決められる（`pickFilledRowIndex`）。行は「金額とメモの入力欄を両方含む、いちばん近い祖先」で
 * 切り出す（クラス名のハッシュや `div` の階層の数に頼らない）。
 *
 * @returns `{ row, amountField }`
 */
export async function pickModalRow(page) {
    const names = page.locator(ITEM_NAME_FIELD)
    const rowCount = await names.count()

    const rows = []
    const amounts = []
    for (let index = 0; index < rowCount; index += 1) {
        const row = names.nth(index).locator('xpath=ancestor::*[.//input[@name="amount"] and .//input[@name="comment"]][1]')
        const amountFields = row.locator('input[name="amount"]')
        const amountCount = await amountFields.count()
        if (amountCount !== 1) {
            await failScreen(page, `品目の行 ${index + 1} に金額の入力欄が ${amountCount} 個あります（1個であるはずです）`)
        }
        rows.push({ row, amountField: amountFields.first() })
        amounts.push(parseAmountValue(await amountFields.first().inputValue()))
    }

    const picked = pickFilledRowIndex(amounts)
    if (picked < 0) {
        const filled = amounts.filter((amount) => amount !== null && amount > 0).length
        // 複数品目の明細はどの行を書き換えるか決められないため、対象外として止める
        // （自動連携明細は1明細1品目が前提）。
        await failScreen(
            page,
            `書き換える品目の行を決められません（品目の行 ${rowCount} 個のうち、金額が入っているのは ${filled} 個。1個であるはずです）`
        )
    }
    return rows[picked]
}

/** 開いた明細が本文の `date` と一致するかを確かめるための、日付の入力欄。 */
export async function dateField(page) {
    return only(page.locator('input[name="date"]'), "日付の入力欄")
}

/**
 * 「更新する」を押し、モーダルが閉じたことを完了の合図として待つ。
 *
 * **完了のシグナルはZaim側に無い。** 更新は画面のJSが送るためURLは変わらず、応答も読めない。
 * モーダルが閉じたことだけを合図にし、閉じなければ、変更されたかどうかを断定できない失敗として
 * 扱う（呼び出し元は記録を残したまま止まる）。
 */
export async function submitEditModal(page) {
    const button = await only(
        page.getByRole("button", { name: UPDATE_BUTTON_NAME, exact: true }),
        `「${UPDATE_BUTTON_NAME}」ボタン`
    )
    await button.click()

    await page
        .waitForFunction(noVisibleModal, undefined, { timeout: SUBMIT_TIMEOUT })
        .catch(() => {
            failAfterSubmit("更新を押しましたが、編集の画面が閉じたことを確認できませんでした")
        })
}

/**
 * 更新の後で一覧を開き直し、その明細の行に**実際に表示されている**カテゴリ・内訳・メモを読む。
 * 「モーダルが閉じた」だけでは更新が通ったと言えないため、書き換えの結果を画面で確かめる。
 *
 * 読み方は `money-list.mjs` と同じ（行は `SearchResult-module__body`、列は前方一致）。
 * 行を見つけられなければ、変更された可能性が残る失敗として扱う。
 */
export async function readListedRow(page, { moneyId, date }) {
    const listUrl = resolveReceiptListUrl(date)
    await page.goto(listUrl, { waitUntil: "networkidle", timeout: PAGE_TIMEOUT })
    await assertLoggedIn(page)

    const trigger = page.locator(receiptEditTriggerSelector(moneyId)).first()
    if ((await trigger.count()) === 0) {
        failAfterSubmit("更新しましたが、一覧に対象の明細が見つからず、反映を確認できませんでした")
    }
    const listed = await trigger.evaluate((el) => {
        const row = el.closest('[class*="SearchResult-module__body"]')
        if (!row) return null
        const text = (node) => (node?.textContent ?? "").replace(/\s+/g, " ").trim()
        const find = (part) => row.querySelector(`[class*="SearchResult-module__${part}"]`)
        return {
            category: find("category")?.querySelector("[data-title]")?.getAttribute("data-title") ?? "",
            genre: text(find("category")?.querySelector('[class*="SearchResult-module__link"]')),
            comment: text(find("comment")),
        }
    })
    if (listed === null) failAfterSubmit("更新しましたが、一覧の行を読めず、反映を確認できませんでした")
    return listed
}
