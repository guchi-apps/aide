/**
 * Zaim Web版の入力画面（`/money/new`）の当て方のうち、**ブラウザが要らない判断だけ**を集めた。
 *
 * `online-accounts.mjs` と同じ流儀で、DOMの当て方でいちばん壊れやすい部分を純粋関数に切り出し、
 * Zaimへ実アクセスせずにテストできるようにしている（`receipt-form.test.ts`）。
 *
 * ## この画面が公式APIと違うところ（#214）
 *
 * Zaimの「レシート置き換え」の候補になるのは**Web版の入力画面で作った明細だけ**で、
 * 公式API（`POST /v2/home/money/payment`）で作ったものは内容が同じでも候補にならない
 * （guchi-apps/asset-manager#300 で実測）。だからこの画面を操作する経路が要る。
 *
 * 画面の作りで押さえておくところ。**どれも実物で確かめた**（2026-08-31）。
 *
 * | | 実際の作り |
 * |---|---|
 * | フォーム | `form#money_new_form`（`action="/receipts"`）。**品目の行は3行で固定**。増やす操作は無い |
 * | 品目名・メモ | `input[name="item_name"]` / `input[name="comment"]`。素直に入力できる |
 * | 金額 | `input[name="amount"]` は **readonly**。クリックで電卓が開き、**キーボード入力＋Enterでしか確定できない**（電卓のボタンは合成クリックに反応しない） |
 * | カテゴリ | IDを受け取る欄が無い。コンボボックスに**名前で絞り込んで選ぶ**しかない |
 * | 出金元 | フォーム内で唯一の `<select>`。`option` の value が**Zaimの口座IDそのもの** |
 * | 日付 | `input[name="date"]`。表示は `2026年8月31日(月)` |
 *
 * クラス名はCSS Modulesのハッシュ付き（`PaymentForm-module__total___3LWZX`）で
 * Zaimのデプロイごとに変わるため、**完全一致では使わない**。使うのは
 * `name` 属性・`placeholder`・ラベルの文言と、ハッシュの手前までの前方一致。
 */

/** 入力画面のURL。未設定でも動くように既定値を持つ。 */
export function resolveReceiptUrl() {
    return process.env.ZAIM_RECEIPT_URL || "https://zaim.net/money/new"
}

/**
 * 「2026年8月」から年月を読む。日付ピッカーの見出しに使う。
 * 読めなければ null（＝Zaim側の表示が変わったので失敗させる）。
 */
export function parseMonthHeader(text) {
    const matched = /(\d{4})\s*年\s*(\d{1,2})\s*月/.exec((text ?? "").replace(/\s+/g, " "))
    if (!matched) return null
    return { year: Number(matched[1]), month: Number(matched[2]) }
}

/** `from` の月から `to` の月まで何か月進めるか。負なら「前」へ戻る。 */
export function monthsBetween(from, to) {
    return (to.year - from.year) * 12 + (to.month - from.month)
}

/** `YYYY-MM-DD` を年・月・日に割る。形は `write.ts` の `isValidDate()` を通った前提。 */
export function splitDate(date) {
    const [year, month, day] = date.split("-").map(Number)
    return { year, month, day }
}

/**
 * 日付欄に入っているべき文字列かを見る。
 *
 * Zaimの表示は `2026年8月31日(月)` で、曜日はZaim側が付ける。**曜日まで組み立てて
 * 突き合わせない**——こちらで曜日を計算すると、ロケールや実装のずれがそのまま
 * 「日付が違う」という誤判定になる。年月日が一致していれば十分。
 */
export function dateMatches(value, date) {
    const parsed = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec((value ?? "").replace(/\s+/g, " "))
    if (!parsed) return false
    const target = splitDate(date)
    return (
        Number(parsed[1]) === target.year &&
        Number(parsed[2]) === target.month &&
        Number(parsed[3]) === target.day
    )
}

/**
 * カテゴリのコンボボックスで、どの候補を選ぶかを決める。
 *
 * **絞り込みは部分一致なので、ジャンル名だけでは決まらない。** 「その他」で絞ると
 * `外税・その他`・`その他交通費` まで残り、さらに**まったく同じ「その他」が
 * カテゴリの数だけ並ぶ**（実物で13件。生活費・娯楽費・交際費…）。
 *
 * メニューは「カテゴリの見出し（`header: true`）→ そのカテゴリのジャンル」の順に並ぶため、
 * 直前の見出しを見ればどのカテゴリのジャンルかが決まる。**ラベルは完全一致で見る**。
 *
 * **DOMに並ぶ全件を受け取り、全件の中での添字を返す。** 絞り込みで隠れた候補も残るため、
 * 「見えているものだけ」を数えると、押すときの添字とずれる（Playwrightの可視判定と
 * `offsetParent` の判定は必ずしも一致しない）。見出しの追跡はDOM順で行い、
 * **選ぶ対象が見えていること**だけを条件にする。
 *
 * @param items DOMに並ぶ全候補（上から順）。`{ header, label, visible }`
 * @returns 選ぶべき要素の添字（全候補の中での位置）。決まらなければ -1
 */
export function pickGenreIndex(items, categoryName, genreName) {
    let currentCategory = null
    for (let index = 0; index < items.length; index += 1) {
        const item = items[index]
        if (item.header) {
            currentCategory = item.label
            continue
        }
        if (!item.visible) continue
        if (currentCategory === categoryName && item.label === genreName) return index
    }
    return -1
}

/**
 * メモ欄へ入れる文字列を作る。
 *
 * **冪等キーをメモへ載せる。** この画面から登録した明細のIDは画面から読めず
 * （履歴の行にIDが振られていない）、呼び出し元は登録済みかどうかをIDで持てない。
 * メモに冪等キーを残しておけば、後からZaim側で引き当てられる（#214）。
 *
 * 上限を超える場合は**切り詰めずに失敗させる**。キーが欠けたメモを残すと、
 * 「載っているのに引けない」という一番たちの悪い状態になる。
 */
export function composeComment(comment, requestId, maxLength) {
    const marker = `#${requestId}`
    const text = comment ? `${comment} ${marker}` : marker
    if (text.length > maxLength) {
        return {
            error:
                `メモと冪等キーの合計が ${maxLength} 文字を超えます（${text.length} 文字）。` +
                "comment を短くするか、requestId を短い値にしてください。",
        }
    }
    return { text }
}

/** 電卓へ打ち込む数字列。金額は1以上の整数である前提（`write.ts` が検査済み）。 */
export function amountDigits(amount) {
    return String(amount)
}

/** 金額欄の表示（`1,880`）を数値に戻す。確定できたかの確認に使う。 */
export function parseAmountValue(value) {
    const digits = (value ?? "").replace(/[^\d]/g, "")
    return digits ? Number(digits) : null
}

/**
 * ページ内で実行される。**この関数はブラウザへ文字列として渡されるため、
 * モジュールスコープの変数を参照できない。**
 *
 * コンボボックスの候補を「見出しかどうか」「ラベル」「見えているか」に畳む。
 * 見出しは `li` 直下のテキスト、ジャンルは `ComboBox-module__label___…` の中にある。
 *
 * **隠れている候補も落とさずに返す。** 落とすと `pickGenreIndex()` の返す添字が
 * DOM上の位置とずれる。
 */
export function readMenuItems(items) {
    return items.map((li) => {
        const label = li.querySelector('[class*="ComboBox-module__label"]')
        return {
            header: label === null,
            label: (label?.textContent ?? li.textContent ?? "").replace(/\s+/g, " ").trim(),
            visible: li.offsetParent !== null,
        }
    })
}
