import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderInlineMarkdown } from "./markdown.ts";

describe("説明文のインラインMarkdown", () => {
  it("**…** を太字にする", () => {
    assert.equal(renderInlineMarkdown("先に**確認**を取る"), "先に<strong>確認</strong>を取る");
  });

  it("`…` を等幅にする", () => {
    assert.equal(renderInlineMarkdown("`on` / `off` が入る"), "<code>on</code> / <code>off</code> が入る");
  });

  it("1つの文に複数の太字があっても、それぞれ別に変換する", () => {
    assert.equal(
      renderInlineMarkdown("**A**は返さない。**B**も返さない。"),
      "<strong>A</strong>は返さない。<strong>B</strong>も返さない。",
    );
  });

  it("コードの中の ** は太字にしない", () => {
    assert.equal(renderInlineMarkdown("`**x**` と**y**"), "<code>**x**</code> と<strong>y</strong>");
  });

  it("閉じていない記号はそのまま文字として残す", () => {
    assert.equal(renderInlineMarkdown("**閉じ忘れ"), "**閉じ忘れ");
    assert.equal(renderInlineMarkdown("`閉じ忘れ"), "`閉じ忘れ");
    assert.equal(renderInlineMarkdown("**** と ``"), "**** と ``");
  });

  it("記法を含まない文はエスケープだけ行う", () => {
    assert.equal(renderInlineMarkdown("a < b & c"), "a &lt; b &amp; c");
  });

  it("混じったHTMLはエスケープされたまま残り、記法の内側でもタグにならない", () => {
    const html = renderInlineMarkdown('**<script>alert(1)</script>** と `<img src=x onerror="y">`');
    assert.ok(!html.includes("<script>"));
    assert.ok(!html.includes("<img"));
    assert.ok(html.includes("<strong>&lt;script&gt;alert(1)&lt;/script&gt;</strong>"));
    assert.ok(html.includes("<code>&lt;img src=x onerror=&quot;y&quot;&gt;</code>"));
  });
});
