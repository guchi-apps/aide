import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { describe, it } from "node:test";
import {
  handshakeCookie,
  HANDSHAKE_COOKIE,
  issueHandshake,
  issueSession,
  loginCookie,
  logoutCookie,
  readCookie,
  readHandshake,
  readSession,
  SESSION_COOKIE,
  sessionCookie,
  stateMatches,
} from "./session.ts";

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);

function requestWith(cookie: string | undefined): IncomingMessage {
  return { headers: cookie === undefined ? {} : { cookie } } as IncomingMessage;
}

describe("動作状況ページのログイン状態", () => {
  it("発行した値は同じ鍵で通り、誰でログインしたかが読める", () => {
    assert.deepEqual(readSession(issueSession(KEY, "me@example.com"), KEY), {
      email: "me@example.com",
    });
  });

  it("パスワードでのログインは身元なしとして通る", () => {
    assert.deepEqual(readSession(issueSession(KEY, null), KEY), { email: null });
  });

  it("別の鍵では通らない（鍵を作り直せば全セッションが失効する）", () => {
    assert.equal(readSession(issueSession(KEY, null), OTHER_KEY), null);
  });

  it("署名を書き換えた値は通らない", () => {
    const value = issueSession(KEY, null);
    const tampered = `${value.slice(0, -1)}${value.endsWith("A") ? "B" : "A"}`;
    assert.equal(readSession(tampered, KEY), null);
  });

  it("期限だけ延ばしても署名が合わないので通らない", () => {
    const now = new Date("2026-08-18T00:00:00Z");
    const value = issueSession(KEY, null, now);
    const [, body, signature] = value.split(".");
    const forged = `${now.getTime() + 999_999_999}.${body}.${signature}`;
    assert.equal(readSession(forged, KEY, now), null);
  });

  it("メールアドレスだけ差し替えた値は通らない（別人を名乗れない）", () => {
    // 署名の対象にメールアドレスが入っていないと、ここが通ってしまう。
    const allowed = issueSession(KEY, "me@example.com");
    const [expiresAt, , signature] = allowed.split(".");
    const forged = [
      expiresAt,
      Buffer.from("someone-else@example.com", "utf8").toString("base64url"),
      signature,
    ].join(".");
    assert.equal(readSession(forged, KEY), null);
  });

  it("期限が切れたら通らない", () => {
    const issuedAt = new Date("2026-08-01T00:00:00Z");
    const value = issueSession(KEY, null, issuedAt);
    assert.notEqual(readSession(value, KEY, new Date("2026-08-02T00:00:00Z")), null);
    // 有効期間は7日。8日後には切れている。
    assert.equal(readSession(value, KEY, new Date("2026-08-09T00:00:01Z")), null);
  });

  it("壊れた値・空の値では通らない", () => {
    for (const value of [undefined, "", ".", "abc", "abc.def", "1.2.3.4"]) {
      assert.equal(readSession(value, KEY), null, `${String(value)} が通ってしまった`);
    }
  });

  it("ログインの往復用の値をセッションとして持ち込めない", () => {
    // 用途ごとに署名の接頭辞を変えていないと、片方の値がもう片方で通ってしまう。
    const handshake = issueHandshake(KEY, { state: "s", verifier: "v" });
    assert.equal(readSession(handshake, KEY), null);
  });

  it("Cookieの値からパスワードを推測する材料を与えない", () => {
    // 鍵をパスワードから導くと、Cookieを1つ手に入れた相手がオフラインで総当たりできる。
    // 回数制限はオンライン試行にしか効かないため、鍵は独立した乱数でなければならない。
    const password = "correct horse battery staple";
    const value = issueSession(KEY, null);
    assert.equal(value.includes(password), false);
    assert.equal(readSession(value, Buffer.from(password, "utf8")), null);
  });
});

describe("Googleログインの往復", () => {
  it("発行した state と verifier を取り出せる", () => {
    const value = issueHandshake(KEY, { state: "abc", verifier: "xyz" });
    assert.deepEqual(readHandshake(value, KEY), { state: "abc", verifier: "xyz" });
  });

  it("書き換えた値は通らない", () => {
    const value = issueHandshake(KEY, { state: "abc", verifier: "xyz" });
    const [expiresAt, , verifier, signature] = value.split(".");
    assert.equal(readHandshake([expiresAt, "zzz", verifier, signature].join("."), KEY), null);
  });

  it("10分で切れる", () => {
    const issuedAt = new Date("2026-08-18T00:00:00Z");
    const value = issueHandshake(KEY, { state: "abc", verifier: "xyz" }, issuedAt);
    assert.notEqual(readHandshake(value, KEY, new Date("2026-08-18T00:09:00Z")), null);
    assert.equal(readHandshake(value, KEY, new Date("2026-08-18T00:10:01Z")), null);
  });

  it("state の照合は一致したときだけ true", () => {
    assert.equal(stateMatches("abc", "abc"), true);
    assert.equal(stateMatches("abc", "abd"), false);
    assert.equal(stateMatches("abc", "abcd"), false);
    assert.equal(stateMatches("", "abc"), false);
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
    assert.doesNotMatch(loginCookie(KEY, { secure: false, email: null }), /Secure/);
    assert.match(loginCookie(KEY, { secure: true, email: null }), /Secure/);
  });

  it("ログインの往復用のCookieも同じ守り方をする", () => {
    const value = handshakeCookie(KEY, { state: "abc", verifier: "xyz" }, true);
    assert.match(value, new RegExp(`^${HANDSHAKE_COOKIE}=`));
    assert.match(value, /HttpOnly/);
    assert.match(value, /SameSite=Lax/);
    assert.match(value, /Secure/);
  });

  it("ログアウトのCookieは即座に消える", () => {
    assert.match(logoutCookie(false), /Max-Age=0/);
    assert.match(logoutCookie(false), new RegExp(`^${SESSION_COOKIE}=;`));
  });
});
