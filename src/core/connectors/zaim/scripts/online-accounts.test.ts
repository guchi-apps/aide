import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractOnlineAccounts, extractOnlineAccountsByRow } from "./online-accounts.mjs";

/**
 * 連携口座一覧のDOMの当て方は、このコネクタでもっとも壊れやすい。
 * Zaimへ実アクセスせずに確かめられるよう、必要な範囲だけのDOMを組んでテストする
 * （`textContent`・`children`・`parentElement`・`querySelector` しか使っていない）。
 */
class StubElement {
  readonly tag: string;
  readonly ownText: string;
  readonly children: StubElement[];
  parentElement: StubElement | null = null;

  // Node 24 の型ストリッピングは parameter property（constructor 引数への修飾子）を
  // 実行できないため、フィールドは明示的に宣言する。
  constructor(tag: string, ownText = "", children: StubElement[] = []) {
    this.tag = tag;
    this.ownText = ownText;
    this.children = children;
    for (const child of children) child.parentElement = this;
  }

  get textContent(): string {
    return [this.ownText, ...this.children.map((child) => child.textContent)].join(" ");
  }

  querySelector(selector: string): StubElement | null {
    const tags = selector.split(",").map((part) => part.trim());
    for (const child of this.children) {
      if (tags.includes(child.tag)) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }
}

/** ページ全体の要素を、Playwrightの locator が返すのと同じ「親も子も含む配列」にする。 */
function flatten(node: StubElement, into: StubElement[] = []): StubElement[] {
  into.push(node);
  for (const child of node.children) flatten(child, into);
  return into;
}

describe("extractOnlineAccounts", () => {
  it("見出しを持つレイアウトから口座名と最終更新を取り出す", () => {
    const page = new StubElement("body", "", [
      new StubElement("div", "", [
        new StubElement("a", "三菱UFJ銀行"),
        new StubElement("div", "￥1,234,567"),
        new StubElement("p", "最終更新：2026年08月16日 14:27:38"),
      ]),
    ]);

    assert.deepEqual(extractOnlineAccounts(flatten(page)), [
      { name: "三菱UFJ銀行", lastUpdatedAt: "最終更新：2026年08月16日 14:27:38" },
    ]);
  });

  it("見出しが無いレイアウトでは金額と最終更新を落としたテキストを口座名にする", () => {
    const page = new StubElement("body", "", [
      new StubElement("li", "", [
        new StubElement("span", "ゆうちょ銀行 ￥100,000"),
        new StubElement("span", "最終更新：2024年12月18日 10:00:00"),
      ]),
    ]);

    assert.deepEqual(extractOnlineAccounts(flatten(page)), [
      { name: "ゆうちょ銀行", lastUpdatedAt: "最終更新：2024年12月18日 10:00:00" },
    ]);
  });

  it("親要素と子要素から同じ口座を二重に拾わない", () => {
    // locator は入れ子の親も子も返すため、素朴に拾うと同じ行が何度も出る。
    const page = new StubElement("body", "", [
      new StubElement("section", "", [
        new StubElement("div", "", [
          new StubElement("h3", "SBI証券"),
          new StubElement("div", "最終更新：2026年08月16日 23:20:11"),
        ]),
        new StubElement("div", "", [
          new StubElement("h3", "楽天証券"),
          new StubElement("div", "最終更新：2026年08月16日 23:21:00"),
        ]),
      ]),
    ]);

    assert.deepEqual(
      extractOnlineAccounts(flatten(page)).map((account) => account.name),
      ["SBI証券", "楽天証券"],
    );
  });

  it("最終更新が無い要素は拾わない", () => {
    const page = new StubElement("body", "", [
      new StubElement("div", "", [
        new StubElement("a", "現金"),
        new StubElement("div", "￥3,000"),
      ]),
    ]);

    assert.deepEqual(extractOnlineAccounts(flatten(page)), []);
  });
});

describe("extractOnlineAccountsByRow", () => {
  it("セレクタが指定されていれば行ごとに名前と最終更新を取る", () => {
    const rows = [
      new StubElement("div", "", [
        new StubElement("h3", "三菱UFJ銀行"),
        new StubElement("p", "最終更新：2026年08月16日 14:27:38"),
      ]),
      // 最終更新が無い行は落とす（連携していない口座が混ざっても壊れないように）。
      new StubElement("div", "", [new StubElement("h3", "現金")]),
    ];

    assert.deepEqual(extractOnlineAccountsByRow(rows, { name: "h3" }), [
      { name: "三菱UFJ銀行", lastUpdatedAt: "最終更新：2026年08月16日 14:27:38" },
    ]);
  });
});
