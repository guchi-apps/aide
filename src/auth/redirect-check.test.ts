import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { checkRedirectAllowed, logRedirectCheck } from "./redirect-check.ts";
import type { SupabaseAuthConfig } from "./supabase.ts";

const CONFIG: SupabaseAuthConfig = {
  url: "https://project.supabase.co",
  publishableKey: "sb_publishable_test",
  allowedEmails: ["me@example.com"],
};

const BASE_URL = "https://aide.example.com";

/** 共有プロジェクトの Site URL（＝#93 で実際に飛ばされた先）に相当するもの。 */
const SITE_URL = "https://another-app.example.com";

/** `Location` を返すだけの Supabase の代役。 */
function respondWith(location: string | null, status = 303): typeof globalThis.fetch {
  return mock.fn(async () =>
    location === null
      ? new Response("{}", { status: 400, headers: { "Content-Type": "application/json" } })
      : new Response(null, { status, headers: { location } }),
  ) as unknown as typeof globalThis.fetch;
}

describe("戻り先URLの検証", () => {
  it("渡した戻り先がそのまま返れば登録済みとみなす", async () => {
    const result = await checkRedirectAllowed(CONFIG, BASE_URL, {
      fetch: respondWith(
        // GoTrue はエラーをフラグメントとして付けて返す。判定には関係しない。
        `${BASE_URL}/status/auth/callback?state=redirect-check#error=access_denied&sb=`,
      ),
    });

    assert.equal(result.status, "ok");
    assert.equal(result.detail, "");
  });

  it("Site URL へ倒されていれば未登録と判定する（#93 の症状そのもの）", async () => {
    const result = await checkRedirectAllowed(CONFIG, BASE_URL, {
      fetch: respondWith(`${SITE_URL}/#error=access_denied&sb=`),
    });

    assert.equal(result.status, "mismatch");
    assert.equal(result.actual, `${SITE_URL}/`);
  });

  it("クエリが落ちた戻り先も未登録として検出する", async () => {
    // 許可リストの照合はフラグメントだけを落とし、**クエリは付いたまま**行われる。
    // パスだけを完全一致で登録すると `?state=` 付きの本番の戻り先は通らないため、
    // パスが同じというだけで「登録済み」にしてはいけない。
    const result = await checkRedirectAllowed(CONFIG, BASE_URL, {
      fetch: respondWith(`${BASE_URL}/status/auth/callback#error=access_denied`),
    });

    assert.equal(result.status, "mismatch");
  });

  it("実際のログインと同じ形（`?state=` 付き）で問い合わせる", async () => {
    const fetch = respondWith(`${BASE_URL}/status/auth/callback?state=redirect-check`);
    await checkRedirectAllowed(CONFIG, BASE_URL, { fetch });

    const [target, init] = (fetch as unknown as ReturnType<typeof mock.fn>).mock.calls[0]
      ?.arguments as [URL, RequestInit];

    assert.equal(target.origin, CONFIG.url);
    assert.equal(target.pathname, "/auth/v1/verify");
    assert.equal(
      target.searchParams.get("redirect_to"),
      `${BASE_URL}/status/auth/callback?state=redirect-check`,
    );
    // 追いかけると Location を読めず、戻り先へ実際のリクエストが飛ぶ。
    assert.equal(init.redirect, "manual");
    assert.deepEqual(init.headers, { apikey: CONFIG.publishableKey });
  });

  it("成立しないトークンを渡す（セッションもメール送信も起こさない）", async () => {
    const fetch = respondWith(`${BASE_URL}/status/auth/callback?state=redirect-check`);
    await checkRedirectAllowed(CONFIG, BASE_URL, { fetch });

    const [target] = (fetch as unknown as ReturnType<typeof mock.fn>).mock.calls[0]
      ?.arguments as [URL];
    const token = target.searchParams.get("token") ?? "";
    assert.ok(token.length > 0);
    // `pkce_` で始まるとPKCEフロー扱いになり、戻り先のクエリが書き換えられてしまう。
    assert.equal(token.startsWith("pkce_"), false);
  });

  it("戻り先が返ってこなければ「確認できなかった」にする（異常とは限らない）", async () => {
    const result = await checkRedirectAllowed(CONFIG, BASE_URL, { fetch: respondWith(null) });

    assert.equal(result.status, "unknown");
    assert.equal(result.actual, null);
  });

  it("Supabaseへ届かなくても例外を投げない", async () => {
    const fetch = mock.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;

    const result = await checkRedirectAllowed(CONFIG, BASE_URL, { fetch });

    assert.equal(result.status, "unknown");
    // 例外の message にはURLが載ることがある。種別だけに落とす。
    assert.equal(result.detail.includes("fetch failed"), false);
  });

  it("画面へ出す説明に共有プロジェクトの Site URL を載せない", async () => {
    const result = await checkRedirectAllowed(CONFIG, BASE_URL, {
      fetch: respondWith(`${SITE_URL}/#error=access_denied`),
    });

    assert.equal(result.detail.includes(SITE_URL), false);
  });
});

describe("起動時のログ", () => {
  it("未登録なら警告として、渡した戻り先と実際の戻り先を両方出す", async () => {
    const warn = mock.method(console, "warn", () => {});
    try {
      await logRedirectCheck(CONFIG, BASE_URL, {
        fetch: respondWith(`${SITE_URL}/#error=access_denied`),
      });

      const message = String(warn.mock.calls[0]?.arguments[0] ?? "");
      assert.ok(message.includes(`${BASE_URL}/status/auth/callback?state=redirect-check`));
      assert.ok(message.includes(SITE_URL));
      assert.ok(message.includes("Redirect URLs"));
    } finally {
      warn.mock.restore();
    }
  });

  it("登録済みなら警告にしない", async () => {
    const warn = mock.method(console, "warn", () => {});
    const log = mock.method(console, "log", () => {});
    try {
      await logRedirectCheck(CONFIG, BASE_URL, {
        fetch: respondWith(`${BASE_URL}/status/auth/callback?state=redirect-check`),
      });

      assert.equal(warn.mock.calls.length, 0);
      assert.equal(log.mock.calls.length, 1);
    } finally {
      warn.mock.restore();
      log.mock.restore();
    }
  });
});
