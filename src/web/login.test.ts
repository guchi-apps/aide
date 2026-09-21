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

  it("見出しは開こうとした画面の名前になる", () => {
    assert.ok(renderLoginPage({ google: true, next: "/features" }).includes("<h1>機能一覧を見る</h1>"));
    assert.ok(renderLoginPage({ google: false, next: "/features" }).includes("<h1>機能一覧を見る</h1>"));
    assert.ok(renderLoginPage({ google: true, next: "/map" }).includes("<h1>アプリ連携を見る</h1>"));
    // 戻り先が無い・知らない値のときは既定の画面（アプリ連携）の名前になる。
    assert.ok(renderLoginPage({ google: true }).includes("<h1>アプリ連携を見る</h1>"));
    assert.ok(renderLoginPage({ google: true, next: "https://example.com/" }).includes("<h1>アプリ連携を見る</h1>"));
  });

  it("機能一覧はログイン後の戻り先として受け付ける", () => {
    assert.equal(safeLanding("/features"), "/features");
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

describe("ヘッダーのアカウントメニュー", () => {
  it("ログイン中のメールアドレスとログアウトをメニューの中に出す", () => {
    const html = accountAction({ email: "me@example.com" }, true);
    const menu = html.slice(html.indexOf('class="account-menu"'));
    assert.ok(menu.includes("me@example.com"));
    assert.ok(menu.includes('action="/status/logout"'));
    // メールアドレスとログアウトは、ボタンの側（常時見える場所）には出さない。
    const button = html.slice(0, html.indexOf('class="account-menu"'));
    assert.ok(!button.includes("me@example.com"));
    assert.ok(!button.includes("ログアウト"));
  });

  it("ボタンがメニューを開く（popover）ように結ばれている", () => {
    const html = accountAction({ email: "me@example.com" }, true);
    const target = /popovertarget="([^"]+)"/.exec(html)?.[1];
    assert.ok(target, "ボタンに popovertarget が無い");
    assert.ok(html.includes(`id="${target}"`));
    assert.ok(html.includes('popover="auto"'));
    assert.ok(html.includes('aria-label="アカウント"'));
  });

  it("メールアドレスが無いセッションでも、ログアウトだけは出す", () => {
    const html = accountAction({ email: null }, true);
    assert.ok(html.includes('action="/status/logout"'));
    assert.ok(!html.includes("ログイン中"));
  });

  it("認証が無効なら何も出さない", () => {
    assert.equal(accountAction({ email: null }, false), "");
  });

  it("メールアドレスもエスケープする", () => {
    assert.ok(!accountAction({ email: "<b>x</b>" }, true).includes("<b>x</b>"));
  });
});
