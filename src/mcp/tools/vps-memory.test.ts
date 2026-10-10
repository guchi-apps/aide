import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import type { ToolResult } from "../types.ts";
import { getSharedToken, resetSharedTokenCacheForTest } from "../../core/connectors/issue-deck/shared-tokens.ts";
import { buildVpsMemoryQuery, vpsMemoryTool } from "./vps-memory.ts";

const TOKEN = "test-vps-memory-token";

function parsed(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}
const call = (args: Record<string, unknown> = {}) => vpsMemoryTool.handler(args, { sessionId: null });

describe("buildVpsMemoryQuery", () => {
  it("hours と history=true を issue-deck の形へ渡す", () => {
    assert.deepEqual(buildVpsMemoryQuery({ hours: 6, history: true }), { hours: 6, history: 1 });
    assert.deepEqual(buildVpsMemoryQuery({}), {});
    assert.deepEqual(buildVpsMemoryQuery({ history: false }), {});
  });
  it("不正な引数は理由の文字列を返す", () => {
    for (const hours of [0, 169, 1.5, "24"]) assert.equal(typeof buildVpsMemoryQuery({ hours }), "string");
    assert.equal(typeof buildVpsMemoryQuery({ history: "1" }), "string");
  });
});

describe("aide_vps_memory", () => {
  beforeEach(async () => {
    process.env["AIDE_ISSUE_DECK_URL"] = "https://deck.example.test/";
    process.env["SHARED_TOKEN_API_SECRET"] = "shared-secret";
    resetSharedTokenCacheForTest();
    await getSharedToken("ISSUE_DECK_VPS_MEMORY_TOKEN", "aide", { fetchImpl: async () => Response.json({ name: "X", value: TOKEN }) });
  });
  afterEach(() => {
    mock.restoreAll();
    delete process.env["AIDE_ISSUE_DECK_URL"];
    delete process.env["SHARED_TOKEN_API_SECRET"];
  });

  it("未設定なら送信せず not_configured（0MBにしない）", async () => {
    resetSharedTokenCacheForTest();
    delete process.env["SHARED_TOKEN_API_SECRET"];
    const fetchMock = mock.method(globalThis, "fetch", async () => new Response("{}"));
    assert.equal(parsed(await call())["status"], "not_configured");
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  it("Bearer付きGETで送り、unavailable・lastSuccessAt・latestAgeSeconds・segments を加工せず返す", async () => {
    const body = {
      schemaVersion: 1,
      latest: { status: "unavailable", reason: "ssh_failed" },
      lastSuccessAt: "2026-10-10T01:00:00.000Z",
      latestAgeSeconds: 5400,
      segments: [
        { key: "100-1", peakRssKb: 500000 },
        { key: "200-2", peakRssKb: 300000 },
      ],
    };
    mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      assert.equal(url.origin + url.pathname, "https://deck.example.test/api/integrations/vps-memory");
      assert.equal(url.searchParams.get("hours"), "12");
      assert.equal(url.searchParams.get("history"), "1");
      assert.equal(init?.method, "GET");
      assert.equal((init?.headers as Record<string, string>)["Authorization"], `Bearer ${TOKEN}`);
      return Response.json(body);
    });
    const result = await call({ hours: 12, history: true });
    const out = parsed(result);
    assert.equal(out["status"], "ok");
    assert.deepEqual(out["data"], body);
    assert.ok(!result.content[0]!.text.includes(TOKEN));
  });

  it("引数不正は送信しない", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => Response.json({ schemaVersion: 1 }));
    assert.equal(parsed(await call({ hours: 999 }))["status"], "invalid_arguments");
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  for (const [httpStatus, status] of [[401, "unauthorized"], [400, "bad_request"], [503, "unavailable"]] as const) {
    it(`HTTP ${httpStatus} は ${status} として返し、本文を出さない`, async () => {
      mock.method(globalThis, "fetch", async () => new Response("secret-body-detail", { status: httpStatus }));
      const result = await call();
      const out = parsed(result);
      assert.equal(out["status"], status);
      assert.equal(out["data"], undefined);
      assert.ok(!result.content[0]!.text.includes("secret-body-detail"));
    });
  }

  it("schemaVersion が無い応答は ok にしない", async () => {
    mock.method(globalThis, "fetch", async () => Response.json({ latest: null }));
    assert.equal(parsed(await call())["status"], "invalid_response");
  });
});
