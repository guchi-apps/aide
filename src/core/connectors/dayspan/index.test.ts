import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { resetSharedTokenCacheForTest } from "../issue-deck/shared-tokens.ts";
import { fetchSchedule, readDaySpanConfig } from "./index.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  delete process.env["AIDE_DAYSPAN_TOKEN"];
  delete process.env["AIDE_DAYSPAN_TARGET_EMAIL"];
  delete process.env["AIDE_DAYSPAN_URL"];
  delete process.env["AIDE_ISSUE_DECK_URL"];
  delete process.env["SHARED_TOKEN_API_SECRET"];
  globalThis.fetch = originalFetch;
  resetSharedTokenCacheForTest();
});

describe("readDaySpanConfig", () => {
  it("AIDE_DAYSPAN_TOKEN が無ければ null（＝叩きに行かない）", async () => {
    assert.equal(await readDaySpanConfig(), null);
  });

  it("対象メールが無ければ null（＝互換分岐を使わない）", async () => {
    process.env["AIDE_DAYSPAN_TOKEN"] = "env-token";
    assert.equal(await readDaySpanConfig(), null);
  });

  it("共有トークンAPIが未設定なら環境変数 AIDE_DAYSPAN_TOKEN にフォールバックする", async () => {
    process.env["AIDE_DAYSPAN_TOKEN"] = "env-token";
    process.env["AIDE_DAYSPAN_TARGET_EMAIL"] = "me@example.com";
    assert.deepEqual(await readDaySpanConfig(), {
      baseUrl: "http://127.0.0.1:3113",
      token: "env-token",
      targetEmail: "me@example.com",
    });
  });

  it("共有トークンAPIから取得できればそちらを優先する", async () => {
    process.env["AIDE_DAYSPAN_TOKEN"] = "env-token";
    process.env["AIDE_DAYSPAN_TARGET_EMAIL"] = "me@example.com";
    process.env["AIDE_ISSUE_DECK_URL"] = "https://deck.example.test";
    process.env["SHARED_TOKEN_API_SECRET"] = "shared-token-api-secret";
    globalThis.fetch = (async (url: string | URL) => {
      assert.equal(String(url), "https://deck.example.test/api/shared-tokens?name=DAYSPAN_INTERNAL_API_KEY");
      return new Response(JSON.stringify({ name: "DAYSPAN_INTERNAL_API_KEY", value: "shared-token" }), { status: 200 });
    }) as typeof fetch;

    assert.deepEqual(await readDaySpanConfig(), {
      baseUrl: "http://127.0.0.1:3113",
      token: "shared-token",
      targetEmail: "me@example.com",
    });
  });
});

describe("fetchSchedule", () => {
  it("対象メールを X-Target-Email として送る", async () => {
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer token");
      assert.equal(headers.get("x-target-email"), "me@example.com");
      return new Response(JSON.stringify({ days: [] }), { status: 200 });
    }) as typeof fetch;

    await fetchSchedule(
      { baseUrl: "https://dayspan.example.test", token: "token", targetEmail: "me@example.com" },
      { days: 1 },
    );
  });
});
