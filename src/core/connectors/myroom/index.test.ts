import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { resetSharedTokenCacheForTest } from "../issue-deck/shared-tokens.ts";
import { readMyRoomConfig } from "./index.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  delete process.env["AIDE_MYROOM_TOKEN"];
  delete process.env["AIDE_MYROOM_URL"];
  delete process.env["AIDE_ISSUE_DECK_URL"];
  delete process.env["SHARED_TOKEN_API_SECRET"];
  globalThis.fetch = originalFetch;
  resetSharedTokenCacheForTest();
});

describe("readMyRoomConfig", () => {
  it("AIDE_MYROOM_TOKEN が無ければ null（＝叩きに行かない）", async () => {
    assert.equal(await readMyRoomConfig(), null);
  });

  it("共有トークンAPIが未設定なら環境変数 AIDE_MYROOM_TOKEN にフォールバックする", async () => {
    process.env["AIDE_MYROOM_TOKEN"] = "env-token";
    assert.deepEqual(await readMyRoomConfig(), { baseUrl: "http://127.0.0.1:8000", token: "env-token" });
  });

  it("共有トークンAPIから取得できればそちらを優先する", async () => {
    process.env["AIDE_MYROOM_TOKEN"] = "env-token";
    process.env["AIDE_ISSUE_DECK_URL"] = "https://deck.example.test";
    process.env["SHARED_TOKEN_API_SECRET"] = "shared-token-api-secret";
    globalThis.fetch = (async (url: string | URL) => {
      assert.equal(String(url), "https://deck.example.test/api/shared-tokens?name=MYROOM_INTERNAL_API_KEY");
      return new Response(JSON.stringify({ name: "MYROOM_INTERNAL_API_KEY", value: "shared-token" }), { status: 200 });
    }) as typeof fetch;

    assert.deepEqual(await readMyRoomConfig(), { baseUrl: "http://127.0.0.1:8000", token: "shared-token" });
  });
});
