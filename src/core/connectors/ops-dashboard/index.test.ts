import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { resetSharedTokenCacheForTest } from "../issue-deck/shared-tokens.ts";
import { readOpsDashboardConfig } from "./index.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  delete process.env["AIDE_OPS_DASHBOARD_TOKEN"];
  delete process.env["AIDE_OPS_DASHBOARD_URL"];
  delete process.env["AIDE_ISSUE_DECK_URL"];
  delete process.env["SHARED_TOKEN_API_SECRET"];
  globalThis.fetch = originalFetch;
  resetSharedTokenCacheForTest();
});

describe("readOpsDashboardConfig", () => {
  it("AIDE_OPS_DASHBOARD_TOKEN が無ければ null（＝叩きに行かない）", async () => {
    assert.equal(await readOpsDashboardConfig(), null);
  });

  it("共有トークンAPIが未設定なら環境変数 AIDE_OPS_DASHBOARD_TOKEN にフォールバックする", async () => {
    process.env["AIDE_OPS_DASHBOARD_TOKEN"] = "env-token";
    assert.deepEqual(await readOpsDashboardConfig(), { baseUrl: "http://127.0.0.1:3110", token: "env-token" });
  });

  it("共有トークンAPIから取得できればそちらを優先する", async () => {
    process.env["AIDE_OPS_DASHBOARD_TOKEN"] = "env-token";
    process.env["AIDE_ISSUE_DECK_URL"] = "https://deck.example.test";
    process.env["SHARED_TOKEN_API_SECRET"] = "shared-token-api-secret";
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      assert.equal(String(url), "https://deck.example.test/api/shared-tokens?name=OPS_API_TOKEN");
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers["X-Shared-Token-Consumer"], "aide");
      return new Response(JSON.stringify({ name: "OPS_API_TOKEN", value: "shared-token" }), { status: 200 });
    }) as typeof fetch;

    assert.deepEqual(await readOpsDashboardConfig(), { baseUrl: "http://127.0.0.1:3110", token: "shared-token" });
  });
});
