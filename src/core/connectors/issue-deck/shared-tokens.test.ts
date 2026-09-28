import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { fetchSharedToken, getSharedToken, readSharedTokenApiConfig, resetSharedTokenCacheForTest } from "./shared-tokens.ts";

const CONFIG = { baseUrl: "https://deck.example.test", secret: "shared-token-api-secret" };

function fetchOk(value: string): typeof fetch {
  return (async () => new Response(JSON.stringify({ name: "X", value }), { status: 200 })) as typeof fetch;
}

describe("readSharedTokenApiConfig", () => {
  it("AIDE_ISSUE_DECK_URL か SHARED_TOKEN_API_SECRET のどちらかが無ければ null", () => {
    assert.equal(readSharedTokenApiConfig({}), null);
    assert.equal(readSharedTokenApiConfig({ AIDE_ISSUE_DECK_URL: "https://deck.example.test" }), null);
    assert.equal(readSharedTokenApiConfig({ SHARED_TOKEN_API_SECRET: "s" }), null);
  });

  it("両方揃っていれば読み取り、末尾のスラッシュは落とす", () => {
    assert.deepEqual(
      readSharedTokenApiConfig({ AIDE_ISSUE_DECK_URL: "https://deck.example.test/", SHARED_TOKEN_API_SECRET: "s" }),
      { baseUrl: "https://deck.example.test", secret: "s" },
    );
  });
});

describe("fetchSharedToken", () => {
  it("Authorization と X-Shared-Token-Consumer を付けて取得する", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const value = await fetchSharedToken(CONFIG, "AIDE_STATUS_TOKEN", "aide", async (url, init) => {
      captured = { url: String(url), init: init! };
      return new Response(JSON.stringify({ name: "AIDE_STATUS_TOKEN", value: "token-value" }), { status: 200 });
    });
    assert.equal(value, "token-value");
    assert.ok(captured);
    const req = captured as unknown as { url: string; init: RequestInit };
    assert.equal(req.url, "https://deck.example.test/api/shared-tokens?name=AIDE_STATUS_TOKEN");
    const headers = req.init.headers as Record<string, string>;
    assert.equal(headers["Authorization"], "Bearer shared-token-api-secret");
    assert.equal(headers["X-Shared-Token-Consumer"], "aide");
  });

  it("見つからない（404）等、HTTPエラーはResponseをthrowする", async () => {
    await assert.rejects(
      fetchSharedToken(CONFIG, "NOT_FOUND", "aide", async () => new Response("", { status: 404 })),
      (cause) => cause instanceof Response && cause.status === 404,
    );
  });

  it("応答にvalueが無ければthrowする", async () => {
    await assert.rejects(
      fetchSharedToken(CONFIG, "X", "aide", async () => new Response(JSON.stringify({ name: "X" }), { status: 200 })),
    );
  });
});

describe("getSharedToken", () => {
  beforeEach(() => {
    resetSharedTokenCacheForTest();
  });

  it("設定が無ければ null（APIを叩かない）", async () => {
    const value = await getSharedToken("AIDE_STATUS_TOKEN", "aide", {
      env: {},
      fetchImpl: async () => {
        throw new Error("must not call");
      },
    });
    assert.equal(value, null);
  });

  it("取得できた値をキャッシュし、TTL内は再取得しない", async () => {
    let calls = 0;
    let now = 1_000;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ name: "AIDE_STATUS_TOKEN", value: "v1" }), { status: 200 });
    };
    const options = { env: { AIDE_ISSUE_DECK_URL: CONFIG.baseUrl, SHARED_TOKEN_API_SECRET: CONFIG.secret }, fetchImpl, ttlMs: 10_000, now: () => now };

    assert.equal(await getSharedToken("AIDE_STATUS_TOKEN", "aide", options), "v1");
    now += 5_000; // TTL内
    assert.equal(await getSharedToken("AIDE_STATUS_TOKEN", "aide", options), "v1");
    assert.equal(calls, 1);
  });

  it("TTLを過ぎたら再取得する", async () => {
    let now = 1_000;
    let call = 0;
    const fetchImpl: typeof fetch = async () => {
      call += 1;
      return new Response(JSON.stringify({ name: "AIDE_STATUS_TOKEN", value: call === 1 ? "v1" : "v2" }), { status: 200 });
    };
    const options = { env: { AIDE_ISSUE_DECK_URL: CONFIG.baseUrl, SHARED_TOKEN_API_SECRET: CONFIG.secret }, fetchImpl, ttlMs: 10_000, now: () => now };

    assert.equal(await getSharedToken("AIDE_STATUS_TOKEN", "aide", options), "v1");
    now += 10_001; // TTLを超える
    assert.equal(await getSharedToken("AIDE_STATUS_TOKEN", "aide", options), "v2");
  });

  it("取得に失敗したら直前の値を使い続ける", async () => {
    let now = 1_000;
    let call = 0;
    const fetchImpl: typeof fetch = async () => {
      call += 1;
      if (call === 1) return new Response(JSON.stringify({ name: "AIDE_STATUS_TOKEN", value: "v1" }), { status: 200 });
      return new Response("", { status: 500 });
    };
    const options = { env: { AIDE_ISSUE_DECK_URL: CONFIG.baseUrl, SHARED_TOKEN_API_SECRET: CONFIG.secret }, fetchImpl, ttlMs: 10_000, now: () => now };

    assert.equal(await getSharedToken("AIDE_STATUS_TOKEN", "aide", options), "v1");
    now += 10_001; // TTLを超えて再取得を試みるが失敗する
    assert.equal(await getSharedToken("AIDE_STATUS_TOKEN", "aide", options), "v1");
  });

  it("一度も取得できておらず、直前の値も無ければ null", async () => {
    const options = {
      env: { AIDE_ISSUE_DECK_URL: CONFIG.baseUrl, SHARED_TOKEN_API_SECRET: CONFIG.secret },
      fetchImpl: async () => new Response("", { status: 500 }),
    };
    assert.equal(await getSharedToken("AIDE_STATUS_TOKEN", "aide", options), null);
  });

  it("トークン名ごとにキャッシュを分ける", async () => {
    const options = {
      env: { AIDE_ISSUE_DECK_URL: CONFIG.baseUrl, SHARED_TOKEN_API_SECRET: CONFIG.secret },
      fetchImpl: fetchOk("shared-value"),
      now: () => 1,
    };
    assert.equal(await getSharedToken("AIDE_STATUS_TOKEN", "aide", options), "shared-value");
    assert.equal(await getSharedToken("AIDE_OPS_DASHBOARD_TOKEN", "aide", options), "shared-value");
  });
});
