import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  amountDigits,
  composeComment,
  dateMatches,
  diffReceiptItems,
  findRegisteredReceipts,
  monthsBetween,
  parseAmountValue,
  parseMonthHeader,
  pickFilledRowIndex,
  pickGenreIndex,
  readMenuItems,
  receiptEditTriggerSelector,
  resolveReceiptListUrl,
} from "./receipt-form.mjs";

/**
 * Zaim Web版の入力画面（`/money/new`）の当て方のテスト（#214）。
 *
 * この画面を間違えて当てると、**金額や出金元が欠けた明細が家計簿に残る**。しかもこの経路は
 * 削除を持たないので、消すのは人の手作業になる。判断だけを純粋関数に切り出し、
 * Zaimへ実アクセスせずに押さえておく（`online-accounts.test.ts` と同じ流儀）。
 */

describe("pickGenreIndex", () => {
  /**
   * 実物のメニューを絞り込んだときの並び。「その他」で絞ると、まったく同じラベルが
   * カテゴリの数だけ残る（実測で13件）。**ジャンル名だけでは決められない。**
   */
  const items = [
    { header: true, label: "食費", visible: true },
    { header: false, label: "外税・その他", visible: true },
    { header: true, label: "交通費", visible: true },
    { header: false, label: "その他交通費", visible: true },
    { header: true, label: "生活費", visible: true },
    { header: false, label: "その他", visible: true },
    { header: true, label: "娯楽費", visible: true },
    { header: false, label: "その他", visible: true },
  ];

  it("直前のカテゴリ見出しとジャンル名の両方が一致する候補を選ぶ", () => {
    assert.equal(pickGenreIndex(items, "生活費", "その他"), 5);
    assert.equal(pickGenreIndex(items, "娯楽費", "その他"), 7);
  });

  it("ラベルは完全一致で見る（部分一致で近い候補を掴まない）", () => {
    // 「その他」で絞った結果に残っているが、これは別のジャンル。
    assert.equal(pickGenreIndex(items, "食費", "その他"), -1);
    assert.equal(pickGenreIndex(items, "食費", "外税・その他"), 1);
  });

  it("見つからなければ -1（呼び出し側は登録せずに止まる）", () => {
    assert.equal(pickGenreIndex(items, "生活費", "存在しないジャンル"), -1);
    assert.equal(pickGenreIndex(items, "存在しないカテゴリ", "その他"), -1);
  });

  it("隠れている候補は選ばないが、添字は全件の中での位置で返す", () => {
    // 絞り込みで隠れた候補もDOMには残る。数え落とすと押すときの添字がずれる。
    const withHidden = [
      { header: true, label: "食費", visible: true },
      { header: false, label: "食料品", visible: false },
      { header: false, label: "外食", visible: true },
    ];
    assert.equal(pickGenreIndex(withHidden, "食費", "食料品"), -1);
    assert.equal(pickGenreIndex(withHidden, "食費", "外食"), 2);
  });
});

describe("readMenuItems", () => {
  /** `querySelector` と `offsetParent` しか使わないので、その2つだけを持つスタブで足りる。 */
  function stub(label: string | null, visible: boolean): unknown {
    return {
      textContent: label ?? "",
      offsetParent: visible ? {} : null,
      querySelector: (selector: string) =>
        selector.includes("ComboBox-module__label") && label !== null
          ? { textContent: ` ${label} ` }
          : null,
    };
  }

  it("見出しとジャンルを区別し、隠れている候補も落とさない", () => {
    // 見出しの li には ComboBox-module__label の子が無い。それが唯一の見分け方。
    const headerLi = { textContent: " 食費 ", offsetParent: {}, querySelector: () => null };
    assert.deepEqual(readMenuItems([headerLi, stub("食料品", false), stub("外食", true)]), [
      { header: true, label: "食費", visible: true },
      { header: false, label: "食料品", visible: false },
      { header: false, label: "外食", visible: true },
    ]);
  });
});

describe("parseMonthHeader / monthsBetween", () => {
  it("日付ピッカーの年月を読む", () => {
    assert.deepEqual(parseMonthHeader("2026年8月"), { year: 2026, month: 8 });
    assert.deepEqual(parseMonthHeader(" 2026 年 12 月 "), { year: 2026, month: 12 });
  });

  it("読めなければ null（表示が変わったので失敗させる）", () => {
    assert.equal(parseMonthHeader("August 2026"), null);
    assert.equal(parseMonthHeader(""), null);
    assert.equal(parseMonthHeader(null), null);
  });

  it("年をまたぐ月送りの回数を出す", () => {
    assert.equal(monthsBetween({ year: 2026, month: 8 }, { year: 2026, month: 6 }), -2);
    assert.equal(monthsBetween({ year: 2026, month: 1 }, { year: 2025, month: 12 }), -1);
    assert.equal(monthsBetween({ year: 2025, month: 12 }, { year: 2026, month: 2 }), 2);
    assert.equal(monthsBetween({ year: 2026, month: 8 }, { year: 2026, month: 8 }), 0);
  });
});

describe("dateMatches", () => {
  it("年月日が一致していれば通す（曜日は見ない）", () => {
    // 曜日はZaimが付ける。こちらで組み立てて突き合わせると、その計算のずれが誤判定になる。
    assert.equal(dateMatches("2026年8月29日(土)", "2026-08-29"), true);
    assert.equal(dateMatches("2026年8月29日(金)", "2026-08-29"), true);
  });

  it("日付が違えば落とす", () => {
    assert.equal(dateMatches("2026年8月28日(金)", "2026-08-29"), false);
    assert.equal(dateMatches("2026年9月29日(火)", "2026-08-29"), false);
    assert.equal(dateMatches("2025年8月29日(金)", "2026-08-29"), false);
  });

  it("読めない表示は落とす（空欄のまま送信させない）", () => {
    assert.equal(dateMatches("", "2026-08-29"), false);
    assert.equal(dateMatches(null, "2026-08-29"), false);
  });
});

describe("composeComment", () => {
  it("冪等キーをメモの末尾へ足す", () => {
    assert.deepEqual(composeComment("レシート取込", "asset-manager:receipt-item:1", 100), {
      text: "レシート取込 #asset-manager:receipt-item:1",
    });
  });

  it("メモが無ければ冪等キーだけを入れる", () => {
    assert.deepEqual(composeComment(undefined, "a:1", 100), { text: "#a:1" });
  });

  it("上限を超えたら切り詰めずに失敗させる", () => {
    // 切り詰めるとキーが欠け、「登録されているのに引けない」状態になる。
    const result = composeComment("x".repeat(90), "asset-manager:receipt-item:1", 100);
    assert.ok("error" in result);
    assert.match(result.error, /100 文字を超えます/);
  });
});

describe("amountDigits / parseAmountValue", () => {
  it("電卓へ打つ数字列を作る", () => {
    assert.equal(amountDigits(1880), "1880");
  });

  it("桁区切り付きの表示を数値に戻す", () => {
    assert.equal(parseAmountValue("1,880"), 1880);
    assert.equal(parseAmountValue("¥1,880"), 1880);
    assert.equal(parseAmountValue("0"), 0);
  });

  it("空欄は null（0と混ぜない）", () => {
    assert.equal(parseAmountValue(""), null);
    assert.equal(parseAmountValue(null), null);
  });
});

describe("resolveReceiptListUrl", () => {
  afterEach(() => {
    delete process.env.ZAIM_MONEY_URL;
  });

  it("明細の日付の月で一覧のURLを組み立てる（編集画面は直接開かない）", () => {
    assert.equal(resolveReceiptListUrl("2026-09-03"), "https://zaim.net/money?month=202609");
  });

  it("環境変数で基点URLを上書きできる（巡回と同じ ZAIM_MONEY_URL）", () => {
    process.env.ZAIM_MONEY_URL = "https://example.test/money";
    assert.equal(resolveReceiptListUrl("2026-12-31"), "https://example.test/money?month=202612");
  });

  it("YYYY-MM-DD でなければ例外にする（別の月の一覧を開かない）", () => {
    assert.throws(() => resolveReceiptListUrl("2026/09/03"));
    assert.throws(() => resolveReceiptListUrl(""));
  });
});

describe("receiptEditTriggerSelector", () => {
  it("一覧の行が持つ data-url で対象の明細を当てる", () => {
    assert.equal(
      receiptEditTriggerSelector(10228209053),
      '[data-url*="/money/10228209053/edit"]',
    );
  });

  it("桁が違う別の明細には部分一致しない（直前の / まで含めて照合する）", () => {
    // `/money/1/edit` は、`/money/11/edit` の部分文字列ではない。
    assert.equal("/money/11/edit".includes("/money/1/edit"), false);
    assert.equal(receiptEditTriggerSelector(1), '[data-url*="/money/1/edit"]');
  });

  it("正の整数でなければ例外にする（セレクタへ任意の文字列を混ぜない）", () => {
    assert.throws(() => receiptEditTriggerSelector(0));
    assert.throws(() => receiptEditTriggerSelector(-1));
    assert.throws(() => receiptEditTriggerSelector(1.5));
    assert.throws(() => receiptEditTriggerSelector("1] , [x" as unknown as number));
  });
});

describe("pickFilledRowIndex", () => {
  it("金額が入っている行がちょうど1つなら、その行を選ぶ（空の行は無視する）", () => {
    assert.equal(pickFilledRowIndex([null, 1880, null]), 1);
    assert.equal(pickFilledRowIndex([1880, null, null]), 0);
  });

  it("金額が入っている行が無ければ決められない", () => {
    assert.equal(pickFilledRowIndex([null, null, null]), -1);
    assert.equal(pickFilledRowIndex([0, null]), -1);
    assert.equal(pickFilledRowIndex([]), -1);
  });

  it("複数品目の明細はどの行か決められない", () => {
    assert.equal(pickFilledRowIndex([500, 1380, null]), -1);
  });
});

describe("findRegisteredReceipts（#614）", () => {
  const base = {
    id: 1,
    parsed_date: "2026-10-10T00:00:00+09:00",
    amount: 1543,
    place: "セブン",
    from_account_name: "反映待ち",
    child_ids: [2, 3, 4, 5, 6, 7],
    comment: "レシート #am:r:1",
  };
  const expected = {
    date: "2026-10-10",
    total: 1543,
    place: "セブン",
    accountName: "反映待ち",
    requestId: "am:r:1",
    lineCount: 7,
  };

  it("日付・合計・店舗・出金元・子明細数・冪等キーが揃う1件だけを返す", () => {
    assert.equal(findRegisteredReceipts([base], expected).length, 1);
  });

  it("子明細が無い（独立取引になった）ものは候補にしない", () => {
    assert.equal(findRegisteredReceipts([{ ...base, child_ids: [] }], expected).length, 0);
  });

  it("冪等キーが前方一致するだけの別取引を拾わない", () => {
    assert.equal(findRegisteredReceipts([{ ...base, comment: "#am:r:12" }], expected).length, 0);
    assert.equal(findRegisteredReceipts([{ ...base, comment: "#am:r:1" }], expected).length, 1);
  });

  it("合計や出金元が違えば外す", () => {
    assert.equal(findRegisteredReceipts([{ ...base, amount: 1500 }], expected).length, 0);
    assert.equal(findRegisteredReceipts([{ ...base, from_account_name: "別口座" }], expected).length, 0);
  });
});

describe("diffReceiptItems（#614）", () => {
  const want = [
    { name: "牛乳", amount: 200, genreName: "食料品" },
    { name: "送料", amount: 500, genreName: "その他" },
  ];
  const row = (name: string, amount: number, genre = "") => ({ id: null, name, amount, genre, category: "" });

  it("並びが違っても全行が一致すれば null", () => {
    const detail = { status: "complete", items: [row("送料", 500, "その他"), row("牛乳", 200, "食料品")] };
    assert.equal(diffReceiptItems(detail, want), null);
  });

  it("欠けた行・余った行・ジャンル違いを理由付きで返す", () => {
    const missing = diffReceiptItems({ status: "complete", items: [row("牛乳", 200)] }, want);
    assert.match(missing ?? "", /「送料」500円の行がありません/);
    const extra = diffReceiptItems(
      { status: "complete", items: [row("牛乳", 200), row("送料", 500), row("謎", 1)] },
      want,
    );
    assert.match(extra ?? "", /送っていない行が 1 行/);
    const genre = diffReceiptItems(
      { status: "complete", items: [row("牛乳", 200, "外食"), row("送料", 500)] },
      want,
    );
    assert.match(genre ?? "", /ジャンルが「外食」/);
  });

  it("内訳を完全に読めていない（partial/failed/none）なら成功にしない", () => {
    for (const status of ["partial", "failed", "none"]) {
      assert.ok(diffReceiptItems({ status, items: [] }, want));
    }
  });
});
