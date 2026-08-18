import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { describe, it } from "node:test";
import {
  issueSession,
  loginCookie,
  logoutCookie,
  readCookie,
  SESSION_COOKIE,
  sessionCookie,
  verifySession,
} from "./session.ts";

const PASSWORD = "correct horse battery staple";

function requestWith(cookie: string | undefined): IncomingMessage {
  return { headers: cookie === undefined ? {} : { cookie } } as IncomingMessage;
}

describe("動作状況ページのログイン状態", () => {
  it("発行した値は同じパスワードで通る", () => {
    assert.equal(verifySession(issueSession(PASSWORD), PASSWORD), true);
  });

  it("パスワードが変われば発行済みの値は通らない", () => {
    const value = issueSession(PASSWORD);
    assert.equal(verifySession(value, "別のパスワード"), false);
  });

  it("署名を書き換えた値は通らない", () => {
    const value = issueSession(PASSWORD);
    const tampered = `${value.slice(0, -1)}${value.endsWith("A") ? "B" : "A"}`;
    assert.equal(verifySession(tampered, PASSWORD), false);
  });

  it("期限だけ延ばしても署名が合わないので通らない", () => {
    const now = new Date("2026-08-18T00:00:00Z");
    const value = issueSession(PASSWORD, now);
    const forged = `${now.getTime() + 999_999_999}.${value.split(".")[1]}`;
    assert.equal(verifySession(forged, PASSWORD, now), false);
  });

  it("期限が切れたら通らない", () => {
    const issuedAt = new Date("2026-08-01T00:00:00Z");
    const value = issueSession(PASSWORD, issuedAt);
    assert.equal(verifySession(value, PASSWORD, new Date("2026-08-02T00:00:00Z")), true);
    // 有効期間は7日。8日後には切れている。
    assert.equal(verifySession(value, PASSWORD, new Date("2026-08-09T00:00:01Z")), false);
  });

  it("壊れた値・空の値では通らない", () => {
    for (const value of [undefined, "", ".", "abc", "abc.def", "1.2.3"]) {
      assert.equal(verifySession(value, PASSWORD), false, `${String(value)} が通ってしまった`);
    }
  });
});

describe("Cookieの読み書き", () => {
  it("複数のCookieから目的の1つを取り出す", () => {
    const req = requestWith(`other=1; ${SESSION_COOKIE}=abc%2Edef; another=2`);
    assert.equal(readCookie(req, SESSION_COOKIE), "abc.def");
  });

  it("Cookieヘッダが無ければ undefined", () => {
    assert.equal(readCookie(requestWith(undefined), SESSION_COOKIE), undefined);
  });

  it("前方一致する別名のCookieを取り違えない", () => {
    const req = requestWith(`${SESSION_COOKIE}_other=x`);
    assert.equal(readCookie(req, SESSION_COOKIE), undefined);
  });

  it("JavaScriptから読めず、他サイトからのPOSTにも付かない", () => {
    const cookie = sessionCookie("v", { secure: true, maxAge: 60 });
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /Path=\//);
  });

  it("公開URLがHTTPSでなければ Secure を付けない（開発機でログインできなくなるため）", () => {
    assert.doesNotMatch(loginCookie(PASSWORD, false), /Secure/);
    assert.match(loginCookie(PASSWORD, true), /Secure/);
  });

  it("ログアウトのCookieは即座に消える", () => {
    assert.match(logoutCookie(false), /Max-Age=0/);
    assert.match(logoutCookie(false), new RegExp(`^${SESSION_COOKIE}=;`));
  });
});
