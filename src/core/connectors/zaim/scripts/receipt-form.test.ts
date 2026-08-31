import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  amountDigits,
  composeComment,
  dateMatches,
  monthsBetween,
  parseAmountValue,
  parseMonthHeader,
  pickGenreIndex,
  readMenuItems,
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
