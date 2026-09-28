import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { AuthConfig } from "../auth/config.ts";
import { ToolRegistry } from "../mcp/registry.ts";
import { pingTool } from "../mcp/tools/ping.ts";
import type { StatusApiOptions } from "./status.ts";

// buildHealth() がキャッシュを読むため、本番のキャッシュを汚さないよう置き場を差し替える。
// AIDE_CACHE_DIR はモジュール読み込み時に確定するため、import より前に設定する必要がある。
const cacheDir = await mkdtemp(join(tmpdir(), "aide-status-api-test-"));
process.env["AIDE_CACHE_DIR"] = cacheDir;
const { handleStatusApi, handleStatusApiChecks, statusSecret } = await import("./status.ts");
const { resetSharedTokenCacheForTest } = await import("../core/connectors/issue-deck/shared-tokens.ts");

const SECRET = "test-only-status-secret";

interface Captured {
  status: number;
  headers: Record<string, string | string[]>;
  body: string;
}

function fakeRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, headers: {}, body: "" };
  const res = {
    writeHead(status: number, headers?: Record<string, string | string[]>) {
      captured.status = status;
      captured.headers = headers ?? {};
      return res;
    },
    end(body?: string) {
      captured.body = body ?? "";
      return res;
    },
  };
  return { res: res as unknown as ServerResponse, captured };
}

function fakeReq(options: { method?: string; authorization?: string } = {}): IncomingMessage {
  const headers: Record<string, string> = {};
  if (options.authorization !== undefined) headers["authorization"] = options.authorization;
  return { method: options.method ?? "GET", headers } as unknown as IncomingMessage;
}

function options(overrides: Partial<StatusApiOptions> = {}): StatusApiOptions {
  const registry = new ToolRegistry();
  registry.register(pingTool);
  const authConfig: AuthConfig = { enabled: true, password: "test" };
  return { authConfig, supabase: null, registry, ...overrides };
}

async function call(
  reqOptions: Parameters<typeof fakeReq>[0] = {},
  handler: typeof handleStatusApi = handleStatusApi,
  apiOptions: StatusApiOptions = options(),
): Promise<Captured> {
  const { res, captured } = fakeRes();
  await handler(fakeReq(reqOptions), res, apiOptions);
  return captured;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  delete process.env["AIDE_STATUS_SECRET"];
  delete process.env["AIDE_BASE_URL"];
  delete process.env["AIDE_ISSUE_DECK_URL"];
  delete process.env["SHARED_TOKEN_API_SECRET"];
  globalThis.fetch = originalFetch;
  resetSharedTokenCacheForTest();
});

describe("statusSecret", () => {
  it("未設定なら null", async () => {
    assert.equal(await statusSecret(), null);
  });

  it("共有トークンAPIが未設定なら環境変数 AIDE_STATUS_SECRET にフォールバックする", async () => {
    process.env["AIDE_STATUS_SECRET"] = SECRET;
    assert.equal(await statusSecret(), SECRET);
  });

  it("共有トークンAPIから取得できればそちらを優先する", async () => {
    process.env["AIDE_STATUS_SECRET"] = SECRET;
    process.env["AIDE_ISSUE_DECK_URL"] = "https://deck.example.test";
    process.env["SHARED_TOKEN_API_SECRET"] = "shared-token-api-secret";
    const SHARED_VALUE = "value-from-shared-token-api";
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      assert.equal(String(url), "https://deck.example.test/api/shared-tokens?name=AIDE_STATUS_TOKEN");
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers["Authorization"], "Bearer shared-token-api-secret");
      assert.equal(headers["X-Shared-Token-Consumer"], "aide");
      return new Response(JSON.stringify({ name: "AIDE_STATUS_TOKEN", value: SHARED_VALUE }), { status: 200 });
    }) as typeof fetch;

    assert.equal(await statusSecret(), SHARED_VALUE);
  });
});

describe("GET /api/status", () => {
  it("シークレット未設定なら503を返す（401とは分ける）", async () => {
    const got = await call({ authorization: `Bearer ${SECRET}` });
    assert.equal(got.status, 503);
    assert.match(JSON.parse(got.body).error, /AIDE_STATUS_SECRET/);
  });

  it("Authorization が無ければ401", async () => {
    process.env["AIDE_STATUS_SECRET"] = SECRET;
    assert.equal((await call()).status, 401);
  });

  it("シークレットが違えば401", async () => {
    process.env["AIDE_STATUS_SECRET"] = SECRET;
    const got = await call({ authorization: "Bearer wrong-secret" });
    assert.equal(got.status, 401);
    assert.ok(!got.body.includes(SECRET));
  });

  it("GET / HEAD 以外は405で Allow を返す（認証より先に判定する）", async () => {
    process.env["AIDE_STATUS_SECRET"] = SECRET;
    const got = await call({ method: "POST", authorization: `Bearer ${SECRET}` });
    assert.equal(got.status, 405);
    assert.equal(got.headers["Allow"], "GET, HEAD");
  });

  it("health と tools を返す", async () => {
    process.env["AIDE_STATUS_SECRET"] = SECRET;
    process.env["AIDE_BASE_URL"] = "https://aide.example.com";

    const got = await call({ authorization: `Bearer ${SECRET}` });
    assert.equal(got.status, 200);
    assert.equal(got.headers["Cache-Control"], "no-store");
    assert.match(got.headers["Content-Type"] as string, /application\/json/);

    const body = JSON.parse(got.body);
    assert.deepEqual(body.tools, ["aide_ping"]);
    assert.equal(typeof body.health.severity, "string");
    // AIDE_BASE_URL から組み立てる。リクエストのHostに依存しない（aide#276）。
    assert.equal(body.health.server.baseUrl, "https://aide.example.com");
    assert.equal(body.health.server.mcpUrl, "https://aide.example.com/mcp");
  });
});

describe("POST /api/status/checks", () => {
  it("シークレット未設定なら503を返す（401とは分ける）", async () => {
    const got = await call({ method: "POST", authorization: `Bearer ${SECRET}` }, handleStatusApiChecks);
    assert.equal(got.status, 503);
    assert.match(JSON.parse(got.body).error, /AIDE_STATUS_SECRET/);
  });

  it("Authorization が無ければ401", async () => {
    process.env["AIDE_STATUS_SECRET"] = SECRET;
    assert.equal((await call({ method: "POST" }, handleStatusApiChecks)).status, 401);
  });

  it("POST 以外は405で Allow を返す", async () => {
    process.env["AIDE_STATUS_SECRET"] = SECRET;
    const got = await call({ authorization: `Bearer ${SECRET}` }, handleStatusApiChecks);
    assert.equal(got.status, 405);
    assert.equal(got.headers["Allow"], "POST");
  });

  it("results を返す", async () => {
    process.env["AIDE_STATUS_SECRET"] = SECRET;
    const got = await call({ method: "POST", authorization: `Bearer ${SECRET}` }, handleStatusApiChecks);
    assert.equal(got.status, 200);
    assert.equal(got.headers["Cache-Control"], "no-store");
    const body = JSON.parse(got.body);
    assert.ok(Array.isArray(body.results));
    assert.ok(body.results.length > 0);
    assert.ok(body.results.every((result: { key: string }) => typeof result.key === "string"));
  });
});
