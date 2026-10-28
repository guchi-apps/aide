import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isValidDate, MAX_TEXT_LENGTH, normalizeId, normalizeText } from "./input.ts";

describe("isValidDate", () => {
  it("実在する日だけを通す", () => {
    assert.equal(isValidDate("2026-02-28"), true);
    assert.equal(isValidDate("2026-02-31"), false);
    assert.equal(isValidDate("2026-2-1"), false);
  });
});

describe("normalizeText", () => {
  it("空文字は指定なし、上限を超える文字列は断る", () => {
    assert.deepEqual(normalizeText("  ", "name"), {});
    assert.deepEqual(normalizeText(" 品目 ", "name"), { value: "品目" });
    assert.ok("error" in normalizeText("あ".repeat(MAX_TEXT_LENGTH + 1), "name"));
    assert.ok("error" in normalizeText(1, "name"));
  });
});

describe("normalizeId", () => {
  it("正の整数だけを通し、必須なら未指定を断る", () => {
    assert.deepEqual(normalizeId(3, "id", true), { value: 3 });
    assert.deepEqual(normalizeId(undefined, "id", false), {});
    assert.ok("error" in normalizeId(undefined, "id", true));
    assert.ok("error" in normalizeId(0, "id", false));
  });
});
