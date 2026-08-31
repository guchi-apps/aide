import { ZAIM_CONTEXT_OPTIONS } from "./context.mjs"
import { resolveStatePath } from "./paths.mjs"
import { loadPlaywright } from "./playwright-loader.mjs"
import {
    amountDigits,
    composeComment,
    dateMatches,
    monthsBetween,
    parseAmountValue,
    parseMonthHeader,
    pickGenreIndex,
    readMenuItems,
    resolveReceiptUrl,
    splitDate,
} from "./receipt-form.mjs"
import { assertLoggedIn } from "./session-check.mjs"

/**
 * Zaim Web版の入力画面（`/money/new`）から品目明細を1件登録する（#214）。
 *
 * **公式APIで作った明細は「レシート置き換え」の候補にならない。** 品目・出金元・日付・金額が
 * まったく同じでも、分かれ目は作成経路にある（guchi-apps/asset-manager#300 で実測）。
 * そのため、置き換えに載せたい明細だけはこの画面を人と同じように操作して作る。
 *
 * ## 黙って進まない
 *
 * 入力欄が見つからないまま進むと、**金額や出金元が欠けた明細が家計簿に残る**。
 * この経路は取り消しを持たないので、消すのは人の手作業になる。したがって
 * **要素の不一致・確認の失敗はすべて例外にして、送信の手前で止める**。
 * 入力し終えたあとも、送信の直前に「入れたつもりの値が実際に入っているか」を読み直す。
 *
 * ## 入出力
 *
 * 入力は環境変数 `ZAIM_WEB_PAYMENT_INPUT`（JSON）。コマンドライン引数ではなく環境変数に
 * するのは、`ps` に店名や金額が出ないようにするため。出力は stdout へJSON1本
 * （`session.ts` の `runZaimScript()` がそのまま受け取る）。
 *
 * `dryRun` を立てると**送信だけを行わない**。フォームを最後まで埋めて、埋まった内容を
 * 返して終える。Zaimに明細を作らずに当て方を確かめられる（`refresh.mjs` の
 * `ZAIM_REFRESH_DRY_RUN` と同じ考え方）。
 */

const PAGE_TIMEOUT = 60_000
/** 送信後に画面が変わるのを待つ上限。 */
const SUBMIT_TIMEOUT = 60_000
/** 入力のたびにReactの再描画を待つ。短すぎると読み直した値が古いまま通る。 */
const SETTLE_MS = 400
/** メモの上限。`write.ts` の `MAX_TEXT_LENGTH` と同じ値を持つ（Zaimが100文字を超えると受け付けない）。 */
const MAX_COMMENT_LENGTH = 100
/** 日付ピッカーで送る「前／次」の上限。これを超える月送りは入力の誤りとみなす。 */
const MAX_MONTH_STEPS = 60

/**
 * **送信の前に**止まった失敗。Zaimには何も登録されていない。
 * マーカーの値は `errors.ts` の `ZAIM_RECEIPT_FORM` と同じ文字列である必要がある。
 */
function fail(message) {
    throw new Error(`ZAIM_RECEIPT_FORM:${message}`)
}

/**
 * **送信した後で**分からなくなった失敗。登録された可能性が残る。
 * マーカーの値は `errors.ts` の `ZAIM_RECEIPT_SUBMITTED` と同じ文字列である必要がある。
 */
function failAfterSubmit(message) {
    throw new Error(`ZAIM_RECEIPT_SUBMITTED:${message}`)
}

function readInput() {
    const raw = process.env.ZAIM_WEB_PAYMENT_INPUT
    if (!raw) fail("ZAIM_WEB_PAYMENT_INPUT が渡されていません")
    try {
        return JSON.parse(raw)
    } catch {
        fail("ZAIM_WEB_PAYMENT_INPUT をJSONとして読めません")
    }
}

/** 1つだけ在るはずの要素を取る。0個でも2個以上でも、画面が変わったとみなして止める。 */
async function only(locator, label) {
    const count = await locator.count()
    if (count !== 1) fail(`${label} が ${count} 個見つかりました（1個であるはずです）`)
    return locator.first()
}

/**
 * カテゴリを選ぶ。
 *
 * コンボボックスに絞り込みの文字を入れてから、**カテゴリの見出しとジャンル名の両方が
 * 一致する候補**を選ぶ（`pickGenreIndex`）。絞り込みは部分一致なので、ジャンル名だけでは
 * 「その他」のように同名の候補がカテゴリの数だけ並ぶ。
 */
async function selectGenre(page, row, categoryName, genreName) {
    // 品目名・金額・メモには name 属性が付いており、カテゴリだけが名無しの入力欄。
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

    // 添字はDOMに並ぶ全候補の中での位置なので、そのまま押せる。
    await options.nth(index).click()
    await page.waitForTimeout(SETTLE_MS)

    const selected = await combo.inputValue()
    if (selected !== genreName) {
        fail(`カテゴリを選べませんでした（欄の値は「${selected}」で、期待は「${genreName}」）`)
    }

    // **候補のメニューを閉じてから次へ進む。** 開いたままだと次のクリックがメニューに
    // 吸われ、金額欄をクリックしても電卓が開かない（開かないまま打つと金額が0のまま通る）。
    await (await only(row.locator('input[name="item_name"]'), "品目名の入力欄")).click()
    await page.waitForTimeout(SETTLE_MS)
}

/**
 * 金額を入れる。
 *
 * **金額欄は readonly で、電卓からしか入らない。** しかも電卓のボタンは合成クリックに
 * 反応しないため（Playwrightの `click()` を受け取らない）、欄をクリックして電卓を開き、
 * キーボードで打って Enter で確定する。ここは実物で確かめた挙動そのもの。
 */
async function enterAmount(page, row, amount) {
    const field = await only(row.locator('input[name="amount"]'), "金額の入力欄")
    const calculator = await only(
        row.locator('div[class*="CalculatorField-module__calculator"]'),
        "金額の電卓"
    )
    await field.click()
    await page.waitForTimeout(SETTLE_MS)
    // 電卓が開いていなければ打っても何も入らない。**開いたことを確かめてから打つ。**
    if (!(await calculator.isVisible())) {
        fail("金額欄をクリックしても電卓が開きませんでした")
    }
    await page.keyboard.type(amountDigits(amount))
    await page.keyboard.press("Enter")
    await page.waitForTimeout(SETTLE_MS)

    const entered = parseAmountValue(await field.inputValue())
    if (entered !== amount) {
        fail(`金額を確定できませんでした（欄の値は ${entered} で、期待は ${amount}）`)
    }
}

/**
 * 日付を入れる。
 *
 * 日付欄は文字列でも受け付けるが、**表示形式（`2026年8月31日(月)`）をこちらで組み立てない**。
 * 曜日を自前で計算すると、その計算のずれがそのまま違う日付での登録になる。
 * ピッカーを開いて「前／次」で目的の月まで送り、日を押す。
 */
async function selectDate(page, form, date) {
    const field = await only(form.locator('input[name="date"]'), "日付の入力欄")
    await field.click()
    await page.waitForTimeout(SETTLE_MS)

    const picker = await only(form.locator('div[class*="DatePicker-module__datePicker"]'), "日付ピッカー")
    const header = await only(picker.locator('div[class*="DatePicker-module__colCenter"]'), "日付ピッカーの年月")
    const current = parseMonthHeader(await header.innerText())
    if (!current) fail("日付ピッカーの年月を読めません")

    const target = splitDate(date)
    const steps = monthsBetween(current, target)
    if (Math.abs(steps) > MAX_MONTH_STEPS) {
        fail(`日付 ${date} が今の表示（${current.year}年${current.month}月）から離れすぎています`)
    }
    const arrow = await only(
        picker.locator(steps < 0 ? 'div[class*="DatePicker-module__colLeft"]' : 'div[class*="DatePicker-module__colRight"]'),
        "日付ピッカーの月送り"
    )
    for (let i = 0; i < Math.abs(steps); i += 1) {
        await arrow.click()
        await page.waitForTimeout(SETTLE_MS)
    }

    const moved = parseMonthHeader(await header.innerText())
    if (!moved || moved.year !== target.year || moved.month !== target.month) {
        fail(`日付ピッカーを ${target.year}年${target.month}月 へ送れませんでした`)
    }

    // 空きマス（前後の月）は別のクラスなので、日付のマスだけを対象にする。
    const day = picker
        .locator('div[class*="DatePicker-module__date___"]')
        .filter({ hasText: new RegExp(`^${target.day}$`) })
    await (await only(day, `日付ピッカーの ${target.day} 日`)).click()
    await page.waitForTimeout(SETTLE_MS)

    const value = await field.inputValue()
    if (!dateMatches(value, date)) {
        fail(`日付を ${date} にできませんでした（欄の値は「${value}」）`)
    }
}

/**
 * 出金元の口座を選ぶ。
 *
 * **`option` の value はZaimの口座IDそのもの**なので、公式API（`fetchZaimMaster()`）で
 * 引いた `accounts[].id` をそのまま渡せる。置き換えの条件は「自動連携しているカードを
 * 出金元にすること」なので、ここが外れると登録できても置き換えに載らない。
 * **既定で先頭の口座が選ばれている。** 選び直さないと、指定と関係ない口座で登録される。
 */
async function selectAccount(form, fromAccountId) {
    const select = await only(form.locator("select"), "出金元の選択欄")
    const wanted = String(fromAccountId)
    const options = await select.locator("option").evaluateAll((els) =>
        els.map((el) => ({ value: el.value, label: (el.textContent ?? "").trim() }))
    )
    const matched = options.find((option) => option.value === wanted)
    if (!matched) {
        fail(`出金元の口座ID ${wanted} が候補にありません（候補 ${options.length} 件）`)
    }
    await select.selectOption(wanted)
    if ((await select.inputValue()) !== wanted) {
        fail(`出金元を口座ID ${wanted} にできませんでした`)
    }
    return matched.label
}

const input = readInput()
const dryRun = input.dryRun === true || process.env.ZAIM_WEB_PAYMENT_DRY_RUN === "1"

const comment = composeComment(input.comment, input.requestId, MAX_COMMENT_LENGTH)
if ("error" in comment) fail(comment.error)

const url = resolveReceiptUrl()
const statePath = resolveStatePath()

const { chromium } = await loadPlaywright()
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ storageState: statePath, ...ZAIM_CONTEXT_OPTIONS })
const page = await context.newPage()

try {
    await page.goto(url, { waitUntil: "networkidle", timeout: PAGE_TIMEOUT })
    // フォームが無い理由の大半はログイン画面へ飛ばされたこと。先にそちらとして判定する。
    await assertLoggedIn(page)

    const form = page.locator(process.env.ZAIM_RECEIPT_FORM_SELECTOR || "#money_new_form")
    if ((await form.count()) === 0) fail(`入力フォームが見つかりません: ${url}`)

    const names = form.locator('input[name="item_name"]')
    const rowCount = await names.count()
    if (rowCount === 0) fail("品目の行が1つも見つかりません")

    // **使わない行を消してから入れる。** 空行がそのまま送られて0円の明細が増えないよう、
    // 「送っても無視されるはず」に賭けない。行の × は合成クリックに反応する（実物で確認済み）。
    for (let i = rowCount - 1; i >= 1; i -= 1) {
        const remove = names
            .nth(i)
            .locator("xpath=ancestor::div[1]/parent::div")
            .locator('div[class*="ItemForm-module__remove"]')
        if ((await remove.count()) === 0) fail(`${i + 1} 行目の削除ボタンが見つかりません`)
        await remove.first().click()
        await page.waitForTimeout(SETTLE_MS)
    }
    if ((await names.count()) !== 1) fail(`品目の行を1行にできませんでした（${await names.count()} 行）`)

    const row = names.first().locator("xpath=ancestor::div[1]/parent::div")

    await (await only(row.locator('input[name="item_name"]'), "品目名の入力欄")).fill(input.name)
    await selectGenre(page, row, input.categoryName, input.genreName)
    await enterAmount(page, row, input.amount)
    await (await only(row.locator('input[name="comment"]'), "メモの入力欄")).fill(comment.text)

    const accountName = await selectAccount(form, input.fromAccountId)
    await selectDate(page, form, input.date)

    const placeField = await only(form.locator('input[placeholder*="お店"]'), "お店の入力欄")
    await placeField.click()
    await placeField.fill(input.place)
    // 候補のメニューが開いたままだと送信ボタンを覆う。品目名へ戻して閉じる。
    await (await only(row.locator('input[name="item_name"]'), "品目名の入力欄")).click()
    await page.waitForTimeout(SETTLE_MS)

    // ---- 送信の直前に、入れたつもりの値を読み直す ----
    const filled = {
        name: await row.locator('input[name="item_name"]').inputValue(),
        genre: await row.locator("input:not([name])").first().inputValue(),
        amount: parseAmountValue(await row.locator('input[name="amount"]').inputValue()),
        comment: await row.locator('input[name="comment"]').inputValue(),
        place: await placeField.inputValue(),
        date: await form.locator('input[name="date"]').inputValue(),
        accountName,
    }
    // 出金元は日付・お店を触った後にもう一度読む。ここが外れると置き換えに載らない。
    const accountValue = await form.locator("select").first().inputValue()
    if (accountValue !== String(input.fromAccountId)) {
        fail(`出金元が ${accountValue} に変わっています（期待は ${input.fromAccountId}）`)
    }
    if (filled.name !== input.name) fail(`品目名が入っていません（欄の値は「${filled.name}」）`)
    if (filled.genre !== input.genreName) fail(`カテゴリが入っていません（欄の値は「${filled.genre}」）`)
    if (filled.amount !== input.amount) fail(`金額が入っていません（欄の値は ${filled.amount}）`)
    if (filled.comment !== comment.text) fail("メモが入っていません")
    if (filled.place !== input.place) fail(`お店が入っていません（欄の値は「${filled.place}」）`)
    if (!dateMatches(filled.date, input.date)) fail(`日付が入っていません（欄の値は「${filled.date}」）`)

    if (dryRun) {
        // Cookieの延長は送信しなくても効く。巡回・一括更新と同じく保存し直す。
        await context.storageState({ path: statePath })
        process.stdout.write(JSON.stringify({ submitted: false, url, filled }))
    } else {
        const submit = await only(form.locator('input[type="submit"]'), "登録ボタン")
        const before = page.url()
        await submit.click()

        // **完了のシグナルはZaim側に無い。** 画面が切り替わるか、フォームが空に戻るかで見る。
        // どちらも起きなければ、登録されたかどうかを断定できない失敗として扱う
        // （呼び出し元は記録を残したまま止まり、次の再送は conflict になる）。
        await page
            .waitForFunction(
                ({ before: previous, name }) => {
                    if (location.href !== previous) return true
                    const first = document.querySelector('input[name="item_name"]')
                    return first !== null && first.value !== name
                },
                { before, name: input.name },
                { timeout: SUBMIT_TIMEOUT }
            )
            .catch(() => {
                failAfterSubmit("送信しましたが、画面が変わったことを確認できませんでした")
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
