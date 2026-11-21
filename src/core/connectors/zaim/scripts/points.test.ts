import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractPointRows } from "./points.mjs";

// 必要な範囲だけのスタブ（`querySelector`・`cloneNode`・`querySelectorAll`・`getAttribute`）。

function link(href: string, name: string, value: string, currency = "") {
  const valueEl = {
    cloneNode: () => ({
      get textContent() {
        return value;
      },
      querySelectorAll: () => (currency ? [{ remove: () => undefined }] : []),
    }),
  };
  return {
    getAttribute: () => href,
    querySelector: (selector: string) =>
      selector === ".name" ? { textContent: name } : selector === ".value" ? valueEl : null,
  };
}

describe("extractPointRows", () => {
  it("名前・数量の表示・idを取り出す（円換算は含めない）", () => {
    const rows = extractPointRows([
      link("/point_accounts/12", " 楽天ポイント ", "210 pt", "¥210 相当"),
      link("/point_accounts/13", "Ponta ポイント", " - "),
    ]);
    assert.deepEqual(rows, [
      { name: "楽天ポイント", amount: "210 pt", id: "12" },
      { name: "Ponta ポイント", amount: "-", id: "13" },
    ]);
  });

  it("名前か値の要素が無い行は落とす", () => {
    assert.deepEqual(extractPointRows([{ getAttribute: () => "", querySelector: () => null }]), []);
  });
});
