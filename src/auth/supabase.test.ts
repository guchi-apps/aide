import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it, mock } from "node:test";
import {
  authorizeUrl,
  createPkce,
  exchangeCode,
  isAllowedEmail,
  loadSupabaseAuthConfig,
  parseAllowedEmails,
  type SupabaseAuthConfig,
} from "./supabase.ts";

const CONFIG: SupabaseAuthConfig = {
  url: "https://project.supabase.co",
  publishableKey: "sb_publishable_test",
  allowedEmails: ["me@example.com"],
};

function env(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return {
    AIDE_SUPABASE_URL: "https://project.supabase.co",
    AIDE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
    AIDE_STATUS_ALLOWED_EMAILS: "me@example.com",
    ...overrides,
  };
}

describe("Googleログインの設定", () => {
  it("3つとも未設定なら null（従来のパスワードでのログインになる）", () => {
    assert.equal(loadSupabaseAuthConfig({}), null);
  });

  it("読み込んだ値は正規化される", () => {
    const config = loadSupabaseAuthConfig(
      env({
        AIDE_SUPABASE_URL: "https://project.supabase.co/",
        AIDE_STATUS_ALLOWED_EMAILS: " Me@Example.com , me@example.com ,, other@example.com ",
      }),
    );
    assert.equal(config?.url, "https://project.supabase.co");
    assert.deepEqual(config?.allowedEmails, ["me@example.com", "other@example.com"]);
  });

  it("許可メールだけ抜けている状態は起動時に落とす", () => {
    // ここを通してしまうと「Googleでログインできる誰でも」が画面を開ける状態になる。
    assert.throws(
      () => loadSupabaseAuthConfig(env({ AIDE_STATUS_ALLOWED_EMAILS: "" })),
      /AIDE_STATUS_ALLOWED_EMAILS/,
    );
  });

  it("カンマだけ・空白だけの許可メールも未設定として扱う", () => {
    assert.throws(
      () => loadSupabaseAuthConfig(env({ AIDE_STATUS_ALLOWED_EMAILS: " , , " })),
      /AIDE_STATUS_ALLOWED_EMAILS/,
    );
  });

  it("URL・公開鍵が片方だけでも落とす", () => {
    assert.throws(() => loadSupabaseAuthConfig(env({ AIDE_SUPABASE_URL: "" })), /AIDE_SUPABASE_URL/);
    assert.throws(
      () => loadSupabaseAuthConfig(env({ AIDE_SUPABASE_PUBLISHABLE_KEY: "" })),
      /AIDE_SUPABASE_PUBLISHABLE_KEY/,
    );
  });

  it("URLとして読めない値は落とす", () => {
    assert.throws(() => loadSupabaseAuthConfig(env({ AIDE_SUPABASE_URL: "project.supabase" })), /URL/);
  });

  it("許可メールの分解は前後の空白・大文字小文字・重複を吸収する", () => {
    assert.deepEqual(parseAllowedEmails("A@b.com, a@B.com"), ["a@b.com"]);
    assert.deepEqual(parseAllowedEmails(undefined), []);
  });
});

describe("画面を開いてよい人の判定", () => {
  it("許可リストにあるアドレスだけ通る", () => {
    assert.equal(isAllowedEmail("me@example.com", CONFIG), true);
    assert.equal(isAllowedEmail("ME@Example.com", CONFIG), true);
    assert.equal(isAllowedEmail(" me@example.com ", CONFIG), true);
  });

  it("それ以外は通らない", () => {
    for (const email of [null, undefined, "", "other@example.com", "me@example.com.evil.test"]) {
      assert.equal(isAllowedEmail(email, CONFIG), false, `${String(email)} が通ってしまった`);
    }
  });
});

describe("認可の開始", () => {
  it("PKCEの challenge は verifier の SHA-256（S256）", () => {
    const { verifier, challenge } = createPkce();
    assert.equal(createHash("sha256").update(verifier).digest("base64url"), challenge);
  });

  it("毎回違う値を作る", () => {
    assert.notEqual(createPkce().verifier, createPkce().verifier);
  });

  it("認可URLにGoogleとPKCEと戻り先が載る", () => {
    const url = new URL(
      authorizeUrl(CONFIG, {
        redirectUri: "https://aide.example.com/status/auth/callback?state=abc",
        challenge: "chal",
      }),
    );
    assert.equal(url.origin + url.pathname, "https://project.supabase.co/auth/v1/authorize");
    assert.equal(url.searchParams.get("provider"), "google");
    assert.equal(
      url.searchParams.get("redirect_to"),
      "https://aide.example.com/status/auth/callback?state=abc",
    );
    assert.equal(url.searchParams.get("code_challenge"), "chal");
    // Supabase は小文字の s256 を期待する。
    assert.equal(url.searchParams.get("code_challenge_method"), "s256");
  });
});

describe("認可コードの交換", () => {
  function respond(status: number, body: unknown) {
    return mock.method(globalThis, "fetch", async () =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
    );
  }

  it("メールアドレスとアクセストークンを取り出す", async (t) => {
    const fetched = respond(200, {
      access_token: "at",
      user: { email: "me@example.com", user_metadata: { email_verified: true } },
    });
    t.after(() => fetched.mock.restore());

    const user = await exchangeCode(CONFIG, { code: "c", verifier: "v" });
    assert.deepEqual(user, { email: "me@example.com", accessToken: "at" });

    const [endpoint, init] = fetched.mock.calls[0]!.arguments as [URL, RequestInit];
    assert.equal(endpoint.searchParams.get("grant_type"), "pkce");
    assert.equal(String(init.body), JSON.stringify({ auth_code: "c", code_verifier: "v" }));
    assert.equal((init.headers as Record<string, string>)["apikey"], CONFIG.publishableKey);
  });

  it("Supabaseが拒否したら失敗させる", async (t) => {
    const fetched = respond(400, { error: "invalid_grant" });
    t.after(() => fetched.mock.restore());
    await assert.rejects(exchangeCode(CONFIG, { code: "c", verifier: "v" }), /HTTP 400/);
  });

  it("メールアドレスが無い応答は通さない", async (t) => {
    const fetched = respond(200, { access_token: "at", user: {} });
    t.after(() => fetched.mock.restore());
    await assert.rejects(exchangeCode(CONFIG, { code: "c", verifier: "v" }), /メールアドレス/);
  });

  it("確認されていないメールアドレスは通さない", async (t) => {
    // Googleでは常に確認済みだが、他の経路が有効になったときに許可リストと
    // 一致するだけのアドレスで入られないようにする。
    const fetched = respond(200, {
      access_token: "at",
      user: { email: "me@example.com", user_metadata: { email_verified: false } },
    });
    t.after(() => fetched.mock.restore());
    await assert.rejects(exchangeCode(CONFIG, { code: "c", verifier: "v" }), /確認されていない/);
  });
});
