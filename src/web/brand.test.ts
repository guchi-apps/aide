import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  BRAND_STYLE,
  LOGO_HEIGHT,
  LOGO_WIDTH,
  logoSize,
  logoSvg,
  MARK_A_PATH,
  MARK_NEEDLE_PATH,
  MARK_RING_PATH,
} from "./brand.ts";
import { brandHtml, renderPage } from "./layout.ts";
import { renderLoginPage } from "./login.ts";

describe("ワードマーク AIde", () => {
  it("表記は AIde で、読み上げ用の名前を持つ", () => {
    const svg = logoSvg();
    assert.match(svg, /role="img"/);
    assert.match(svg, /aria-label="AIde"/);
    // 大文字・小文字の取り違え（AIDE / Aide）が紛れ込まない。
    assert.doesNotMatch(svg, /AIDE|Aide/);
  });

  it("IDを持たない（同じページへ何度置いても衝突しない）", () => {
    assert.doesNotMatch(logoSvg(), /\sid=/);
  });

  it("縦横比を保ったまま大きさを決める", () => {
    const [, width, height] = /width="(\d+)" height="(\d+)"/.exec(logoSize(28)) ?? [];
    assert.equal(Number(height), 28);
    assert.ok(Math.abs(Number(width) / Number(height) - LOGO_WIDTH / LOGO_HEIGHT) < 0.02);
  });

  it("ダークモードでも読めるよう、色はCSS変数で切り替える", () => {
    assert.match(BRAND_STYLE, /prefers-color-scheme:dark/);
    for (const name of ["--logo-ai", "--logo-de", "--logo-needle"]) {
      assert.ok(BRAND_STYLE.includes(`${name}:`), `${name} が定義されていない`);
    }
    // 要素側は色を直書きせず、変数を参照する（直書きだとダークで切り替わらない）。
    assert.doesNotMatch(logoSvg(), /fill="#|stroke="#/);
  });

  it("ロボットの絵を含まない（ブランドを別デザインに依存させない）", () => {
    assert.doesNotMatch(logoSvg(), /robot|ロボット|<image/i);
  });
});

describe("画面のブランド表示", () => {
  it("左上は AIDE の文字ではなくロゴを置く", () => {
    const html = renderPage({ title: "t", body: "<p>x</p>", nav: [{ href: "/map", label: "アプリ連携", current: true }] });
    assert.ok(html.includes(`<div class="topbar">${brandHtml()}`));
    assert.match(html, /<span class="brand"><svg class="logo"[^>]*aria-label="AIde"/);
    assert.doesNotMatch(html, /class="brand">AIDE</);
  });

  it("ログイン画面も同じロゴを使う", () => {
    for (const google of [true, false]) {
      const html = renderLoginPage({ google });
      assert.ok(html.includes(brandHtml()), `google=${google}`);
      assert.doesNotMatch(html, /class="brand">AIDE</);
    }
  });

  it("共通CSSにロゴの色と、ヘッダーで潰れない大きさが入っている", () => {
    const html = renderPage({ title: "t", body: "", nav: [{ href: "/map", label: "x", current: false }] });
    assert.ok(html.includes("--logo-ai:"));
    assert.match(html, /\.brand svg\{height:[\d.]+rem;width:auto\}/);
  });
});

describe("アイコンとの共通の字形", () => {
  it("icon.svg は brand.ts と同じパスでAとリングと針を描いている", async () => {
    const icon = await readFile(new URL("./icons/icon.svg", import.meta.url), "utf8");
    for (const [name, d] of [
      ["A", MARK_A_PATH],
      ["リング", MARK_RING_PATH],
      ["針", MARK_NEEDLE_PATH],
    ] as const) {
      assert.ok(icon.includes(`d="${d}"`), `icon.svg の${name}が brand.ts と食い違っている。icon.svgを描き直す`);
    }
  });

  it("icon.svg の地は角を丸めず全面を塗り、表記は AIde", async () => {
    const icon = await readFile(new URL("./icons/icon.svg", import.meta.url), "utf8");
    assert.match(icon, /<rect width="512" height="512" fill="#[0-9a-f]{6}"\/>/i);
    assert.doesNotMatch(icon, /<rect[^>]*\brx=/);
    assert.match(icon, /aria-label="AIde"/);
    assert.doesNotMatch(icon, /<text|<image/);
  });
});
