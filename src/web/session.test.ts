import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
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

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);

function requestWith(cookie: string | undefined): IncomingMessage {
  return { headers: cookie === undefined ? {} : { cookie } } as IncomingMessage;
}

describe("動作状況ページのログイン状態", () => {
  it("発行した値は同じ鍵で通る", () => {
    assert.equal(verifySession(issueSession(KEY), KEY), true);
  });

  it("別の鍵では通らない（鍵を作り直せば全セッションが失効する）", () => {
    assert.equal(verifySession(issueSession(KEY), OTHER_KEY), false);
  });

  it("署名を書き換えた値は通らない", () => {
    const value = issueSession(KEY);
    const tampered = `${value.slice(0, -1)}${value.endsWith("A") ? "B" : "A"}`;
    assert.equal(verifySession(tampered, KEY), false);
  });

  it("期限だけ延ばしても署名が合わないので通らない", () => {
    const now = new Date("2026-08-18T00:00:00Z");
    const value = issueSession(KEY, now);
    const forged = `${now.getTime() + 999_999_999}.${value.split(".")[1]}`;
    assert.equal(verifySession(forged, KEY, now), false);
  });

  it("期限が切れたら通らない", () => {
    const issuedAt = new Date("2026-08-01T00:00:00Z");
    const value = issueSession(KEY, issuedAt);
    assert.equal(verifySession(value, KEY, new Date("2026-08-02T00:00:00Z")), true);
    // 有効期間は7日。8日後には切れている。
    assert.equal(verifySession(value, KEY, new Date("2026-08-09T00:00:01Z")), false);
  });

  it("壊れた値・空の値では通らない", () => {
    for (const value of [undefined, "", ".", "abc", "abc.def", "1.2.3"]) {
      assert.equal(verifySession(value, KEY), false, `${String(value)} が通ってしまった`);
    }
  });

  it("Cookieの値からパスワードを推測する材料を与えない", () => {
    // 鍵をパスワードから導くと、Cookieを1つ手に入れた相手がオフラインで総当たりできる。
    // 回数制限はオンライン試行にしか効かないため、鍵は独立した乱数でなければならない。
    const password = "correct horse battery staple";
    const value = issueSession(KEY);
    assert.equal(value.includes(password), false);
    assert.equal(verifySession(value, Buffer.from(password, "utf8")), false);
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

  it("HTTPSで届いていなければ Secure を付けない（開発機でログインできなくなるため）", () => {
    assert.doesNotMatch(loginCookie(KEY, false), /Secure/);
    assert.match(loginCookie(KEY, true), /Secure/);
  });

  it("ログアウトのCookieは即座に消える", () => {
    assert.match(logoutCookie(false), /Max-Age=0/);
    assert.match(logoutCookie(false), new RegExp(`^${SESSION_COOKIE}=;`));
  });
});
