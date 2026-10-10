import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it, mock } from "node:test";
import {
  authorizeUrl,
  callbackUrl,
  createPkce,
  exchangeCode,
  loadSupabaseAuthConfig,
  revokeSession,
  type SupabaseAuthConfig,
} from "./supabase.ts";

const CONFIG: SupabaseAuthConfig = {
  url: "https://project.supabase.co",
  publishableKey: "sb_publishable_test",
};

function env(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return {
    AIDE_SUPABASE_URL: "https://project.supabase.co",
    AIDE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
    ...overrides,
  };
}

describe("Googleログインの設定", () => {
  it("2つとも未設定なら null（従来のパスワードでのログインになる）", () => {
    assert.equal(loadSupabaseAuthConfig({}), null);
  });

  it("読み込んだ値は正規化される", () => {
    const config = loadSupabaseAuthConfig(env({ AIDE_SUPABASE_URL: "https://project.supabase.co/" }));
    assert.equal(config?.url, "https://project.supabase.co");
  });

  it("許可メールは設定に持たない（旧環境変数が残っていても判定には使わない）", () => {
    const config = loadSupabaseAuthConfig(env({ AIDE_STATUS_ALLOWED_EMAILS: "me@example.com" }));
    assert.deepEqual(Object.keys(config ?? {}).sort(), ["publishableKey", "url"]);
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
});

describe("認可の開始", () => {
  it("戻り先は state をクエリに載せた形になる（許可リストの照合対象そのもの）", () => {
    assert.equal(
      callbackUrl("https://aide.example.com", "abc"),
      "https://aide.example.com/status/auth/callback?state=abc",
    );
    // 末尾スラッシュの有無でパスが変わらないこと（一致しないとSite URLへ倒される・#93）。
    assert.equal(
      callbackUrl("https://aide.example.com/", "abc"),
      "https://aide.example.com/status/auth/callback?state=abc",
    );
  });

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
      user: {
        id: "user-1",
        email: "me@example.com",
        email_confirmed_at: "2026-01-01T00:00:00Z",
        user_metadata: { email_verified: true },
      },
    });
    t.after(() => fetched.mock.restore());

    const user = await exchangeCode(CONFIG, { code: "c", verifier: "v" });
    assert.deepEqual(user, { sub: "user-1", email: "me@example.com", emailVerified: true, accessToken: "at" });

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
      user: { id: "user-1", email: "me@example.com", user_metadata: { email_verified: false } },
    });
    t.after(() => fetched.mock.restore());
    await assert.rejects(exchangeCode(CONFIG, { code: "c", verifier: "v" }), /確認されていない/);
  });
});

describe("Supabaseセッションの失効", () => {
  function jwt(payload: unknown): string {
    const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    return `${part({ alg: "HS256" })}.${part(payload)}.sig`;
  }
  const WITH_SESSION = jwt({ session_id: "s1" });

  it("scope=local とこのトークンのBearerだけで呼ぶ", async (t) => {
    const fetched = mock.method(globalThis, "fetch", async () => new Response(null, { status: 204 }));
    t.after(() => fetched.mock.restore());

    await revokeSession(CONFIG, WITH_SESSION);

    assert.equal(fetched.mock.calls.length, 1);
    const [endpoint, init] = fetched.mock.calls[0]!.arguments as [URL, RequestInit];
    assert.equal(endpoint.pathname, "/auth/v1/logout");
    assert.equal(endpoint.searchParams.get("scope"), "local");
    assert.deepEqual([...endpoint.searchParams.keys()], ["scope"]);
    assert.equal(init.method, "POST");
    assert.equal((init.headers as Record<string, string>)["Authorization"], `Bearer ${WITH_SESSION}`);
  });

  it("セッションを特定できないトークンでは呼ばない（globalへ落とさない）", async (t) => {
    const fetched = mock.method(globalThis, "fetch", async () => new Response(null, { status: 204 }));
    const warned = mock.method(console, "warn", () => {});
    t.after(() => {
      fetched.mock.restore();
      warned.mock.restore();
    });

    for (const token of ["", "opaque", jwt({}), jwt({ session_id: "" }), "a.!!!.c"]) {
      await revokeSession(CONFIG, token);
    }
    assert.equal(fetched.mock.calls.length, 0);
  });

  it("HTTP非成功はログに残し、トークンは出さない", async (t) => {
    const fetched = mock.method(globalThis, "fetch", async () => new Response("{}", { status: 403 }));
    const warned = mock.method(console, "warn", () => {});
    t.after(() => {
      fetched.mock.restore();
      warned.mock.restore();
    });

    await revokeSession(CONFIG, WITH_SESSION);
    const logged = warned.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
    assert.match(logged, /HTTP 403/);
    assert.ok(!logged.includes(WITH_SESSION));
  });

  it("通信失敗でも例外にせず、再試行でglobalを呼ばない", async (t) => {
    const fetched = mock.method(globalThis, "fetch", async () => {
      throw new TypeError("fetch failed " + WITH_SESSION);
    });
    const warned = mock.method(console, "warn", () => {});
    t.after(() => {
      fetched.mock.restore();
      warned.mock.restore();
    });

    await revokeSession(CONFIG, WITH_SESSION);
    assert.equal(fetched.mock.calls.length, 1);
    const logged = warned.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
    assert.ok(!logged.includes(WITH_SESSION));
  });
});
