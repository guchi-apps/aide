import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { resetSharedTokenCacheForTest } from "./shared-tokens.ts";
import { readIssueDeckUploadConfig } from "./upload.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  delete process.env["AIDE_ISSUE_DECK_URL"];
  delete process.env["AIDE_ISSUE_DECK_UPLOAD_TOKEN"];
  delete process.env["SHARED_TOKEN_API_SECRET"];
  globalThis.fetch = originalFetch;
  resetSharedTokenCacheForTest();
});

describe("readIssueDeckUploadConfig", () => {
  it("AIDE_ISSUE_DECK_URL か AIDE_ISSUE_DECK_UPLOAD_TOKEN のどちらかが無ければ null（＝送信しない）", async () => {
    assert.equal(await readIssueDeckUploadConfig(), null);
    process.env["AIDE_ISSUE_DECK_URL"] = "https://deck.example.test";
    assert.equal(await readIssueDeckUploadConfig(), null);
  });

  it("共有トークンAPIが未設定なら環境変数 AIDE_ISSUE_DECK_UPLOAD_TOKEN にフォールバックする（aide#486）", async () => {
    process.env["AIDE_ISSUE_DECK_URL"] = "https://deck.example.test/";
    process.env["AIDE_ISSUE_DECK_UPLOAD_TOKEN"] = "env-token";
    assert.deepEqual(await readIssueDeckUploadConfig(), { baseUrl: "https://deck.example.test", token: "env-token" });
  });

  it("共有トークンAPIから取得できればそちらを優先する", async () => {
    process.env["AIDE_ISSUE_DECK_URL"] = "https://deck.example.test";
    process.env["AIDE_ISSUE_DECK_UPLOAD_TOKEN"] = "env-token";
    process.env["SHARED_TOKEN_API_SECRET"] = "shared-token-api-secret";
    globalThis.fetch = (async (url: string | URL) => {
      assert.equal(String(url), "https://deck.example.test/api/shared-tokens?name=ISSUE_DECK_IMAGE_UPLOAD_SECRET");
      return new Response(JSON.stringify({ name: "ISSUE_DECK_IMAGE_UPLOAD_SECRET", value: "shared-token" }), { status: 200 });
    }) as typeof fetch;

    assert.deepEqual(await readIssueDeckUploadConfig(), { baseUrl: "https://deck.example.test", token: "shared-token" });
  });
});
