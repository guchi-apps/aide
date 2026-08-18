import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertLoggedIn, type ZaimSessionCheckPage } from "./session-check.mjs";

/**
 * ログイン判定はZaimへ実アクセスせずに確かめたいので、`assertLoggedIn` が使う
 * `url()` と `locator().count()` だけを持つ最小のページを組む。
 */
function fakePage(url: string, passwordFields = 0): ZaimSessionCheckPage {
  return {
    url: () => url,
    locator: (selector: string) => ({
      count: async () => (selector === 'input[type="password"]' ? passwordFields : 0),
    }),
  };
}

describe("Zaimのログイン判定", () => {
  it("SSOのログイン画面へ飛ばされていたら失効とみなす", async () => {
    await assert.rejects(
      assertLoggedIn(fakePage("https://id.kufu.jp/signin?login_challenge=abc")),
      /ZAIM_SESSION_EXPIRED/,
    );
  });

  it("Zaim側のドメインでもパスワード入力欄があれば失効とみなす", async () => {
    await assert.rejects(assertLoggedIn(fakePage("https://zaim.net/user_session/new", 1)), /ZAIM_SESSION_EXPIRED/);
  });

  // #89: 連携口座一覧は本文に「ログイン」を含み金額を載せない。文言で判定していた頃は
  // ここで必ず失効と誤判定し、zaim-refresh が一度も成功しなかった。
  it("金額を載せないページ（連携口座一覧）を失効とみなさない", async () => {
    await assertLoggedIn(fakePage("https://zaim.net/online_accounts"));
  });

  it("残高一覧を失効とみなさない", async () => {
    await assertLoggedIn(fakePage("https://zaim.net/money"));
  });

  it("ドメイン名の一部が id.kufu.jp に似ているだけでは失効とみなさない", async () => {
    await assertLoggedIn(fakePage("https://zaim.net/redirect?to=id.kufu.jp"));
  });
});
