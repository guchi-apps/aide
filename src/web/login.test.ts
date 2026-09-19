import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { accountAction, renderLoginPage, safeLanding } from "./login.ts";

describe("ログイン画面", () => {
  it("パスワードだけを尋ね、値を埋め込まない", () => {
    const html = renderLoginPage({ google: false });
    assert.ok(html.includes('type="password"'));
    assert.ok(html.includes('action="/status/login"'));
    // パスワード欄に値を入れて返さない（戻り先の hidden は除く）。
    assert.doesNotMatch(html, /type="password"[^>]*value=/);
  });

  it("Googleログインが有効なら、パスワード欄を出さない", () => {
    // 残すと「許可したメールアドレスの人しか開けない」制限がパスワード1本で迂回できる。
    const html = renderLoginPage({ google: true });
    assert.ok(html.includes('href="/status/auth/start?next='));
    assert.ok(html.includes("Googleでログイン"));
    assert.ok(!html.includes('type="password"'));
    assert.ok(!html.includes('action="/status/login"'));
  });

  it("開こうとした画面を戻り先として持ち回る", () => {
    assert.ok(renderLoginPage({ google: false, next: "/features" }).includes('name="next" value="/features"'));
    assert.ok(renderLoginPage({ google: true, next: "/features" }).includes("next=%2Ffeatures"));
  });

  it("知らない戻り先は既定へ落とす", () => {
    // 外部URLをそのまま Location に載せると、ログイン直後に別サイトへ送り出す踏み台になる。
    const html = renderLoginPage({ google: false, next: "https://example.com/" });
    assert.ok(html.includes('name="next" value="/map"'));
    assert.ok(!html.includes("example.com"));
    assert.equal(safeLanding("//example.com"), "/map");
    assert.equal(safeLanding(null), "/map");
    assert.equal(safeLanding("/map"), "/map");
    // 外した画面は戻り先として受け付けない（リダイレクトの往復になるだけ）。
    assert.equal(safeLanding("/status"), "/map");
    assert.equal(safeLanding("/knowledge"), "/map");
  });

  it("失敗の理由を出す", () => {
    const html = renderLoginPage({ google: false, error: "パスワードが違います。" });
    assert.ok(html.includes("パスワードが違います。"));
  });

  it("許可されていないアカウントには、誰なら開けるのかを教えない", () => {
    const html = renderLoginPage({ google: true, error: "このアカウントでは開けません。" });
    assert.ok(html.includes("このアカウントでは開けません。"));
    // 許可リストの中身が画面に出ると、総当たりの手がかりになる。
    assert.doesNotMatch(html, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  });

  it("エラー文もエスケープする", () => {
    assert.ok(!renderLoginPage({ google: false, error: "<b>x</b>" }).includes("<b>x</b>"));
  });
});

describe("ヘッダーのログアウト", () => {
  it("ログイン中のメールアドレスとログアウトを出す", () => {
    const html = accountAction({ email: "me@example.com" }, true);
    assert.ok(html.includes("me@example.com"));
    assert.ok(html.includes('action="/status/logout"'));
  });

  it("認証が無効なら何も出さない", () => {
    assert.equal(accountAction({ email: null }, false), "");
  });

  it("メールアドレスもエスケープする", () => {
    assert.ok(!accountAction({ email: "<b>x</b>" }, true).includes("<b>x</b>"));
  });
});
