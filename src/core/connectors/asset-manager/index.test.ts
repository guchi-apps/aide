import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { resetSharedTokenCacheForTest } from "../issue-deck/shared-tokens.ts";
import { readAssetManagerConfig } from "./index.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  delete process.env["AIDE_ASSET_MANAGER_ZAIM_SYNC_SECRET"];
  delete process.env["AIDE_ASSET_MANAGER_URL"];
  delete process.env["AIDE_ISSUE_DECK_URL"];
  delete process.env["SHARED_TOKEN_API_SECRET"];
  globalThis.fetch = originalFetch;
  resetSharedTokenCacheForTest();
});

describe("readAssetManagerConfig", () => {
  it("AIDE_ASSET_MANAGER_ZAIM_SYNC_SECRET が無ければ null（＝叩きに行かない）", async () => {
    assert.equal(await readAssetManagerConfig(), null);
  });

  it("共有トークンAPIが未設定なら環境変数 AIDE_ASSET_MANAGER_ZAIM_SYNC_SECRET にフォールバックする", async () => {
    process.env["AIDE_ASSET_MANAGER_ZAIM_SYNC_SECRET"] = "env-secret";
    assert.deepEqual(await readAssetManagerConfig(), { baseUrl: "https://asset.gucchii.com", secret: "env-secret" });
  });

  it("共有トークンAPIから取得できればそちらを優先する", async () => {
    process.env["AIDE_ASSET_MANAGER_ZAIM_SYNC_SECRET"] = "env-secret";
    process.env["AIDE_ISSUE_DECK_URL"] = "https://deck.example.test";
    process.env["SHARED_TOKEN_API_SECRET"] = "shared-token-api-secret";
    globalThis.fetch = (async (url: string | URL) => {
      assert.equal(String(url), "https://deck.example.test/api/shared-tokens?name=ASSET_MANAGER_ZAIM_SYNC_SECRET");
      return new Response(JSON.stringify({ name: "ASSET_MANAGER_ZAIM_SYNC_SECRET", value: "shared-secret" }), { status: 200 });
    }) as typeof fetch;

    assert.deepEqual(await readAssetManagerConfig(), { baseUrl: "https://asset.gucchii.com", secret: "shared-secret" });
  });
});
