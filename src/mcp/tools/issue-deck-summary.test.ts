import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import type { ToolResult } from "../types.ts";
import { getSharedToken, resetSharedTokenCacheForTest } from "../../core/connectors/issue-deck/shared-tokens.ts";
import { buildQuery, issueDeckItemsTool, issueDeckSummaryTool } from "./issue-deck-summary.ts";

const TOKEN = "test-summary-token";

function parsed(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}
const summary = (args: Record<string, unknown> = {}) => issueDeckSummaryTool.handler(args, { sessionId: null });
const items = (args: Record<string, unknown>) => issueDeckItemsTool.handler(args, { sessionId: null });

describe("buildQuery", () => {
  it("repo は repositoryFullName へ、期間・timezone はそのまま渡す", () => {
    assert.deepEqual(
      buildQuery({ repo: "guchi-apps/aide", from: "2026-10-01T00:00:00+09:00", to: "2026-10-08T00:00:00+09:00", timezone: "Asia/Tokyo" }, false),
      { repositoryFullName: "guchi-apps/aide", from: "2026-10-01T00:00:00+09:00", to: "2026-10-08T00:00:00+09:00", timezone: "Asia/Tokyo" },
    );
  });
  it("不正な引数は理由の文字列を返す", () => {
    assert.equal(typeof buildQuery({ repo: "aide" }, false), "string");
    assert.equal(typeof buildQuery({ from: "yesterday" }, false), "string");
    assert.equal(typeof buildQuery({ from: "2026-10-08T00:00:00Z", to: "2026-10-01T00:00:00Z" }, false), "string");
    assert.equal(typeof buildQuery({ timezone: "../x?" }, false), "string");
  });
  it("items は category 必須で、limit は1〜100の整数", () => {
    assert.equal(typeof buildQuery({}, true), "string");
    assert.equal(typeof buildQuery({ category: "reserved", limit: 0 }, true), "string");
    assert.equal(typeof buildQuery({ category: "reserved", limit: 101 }, true), "string");
    assert.equal(typeof buildQuery({ category: "reserved", limit: 1.5 }, true), "string");
    assert.deepEqual(buildQuery({ category: "reserved", cursor: "abc", limit: 20 }, true), { category: "reserved", cursor: "abc", limit: 20 });
  });
  it("summary は category・cursor・limit を送らない", () => {
    assert.deepEqual(buildQuery({ category: "x", cursor: "y", limit: 5 }, false), {});
  });
});

describe("aide_issue_deck_summary / items", () => {
  beforeEach(async () => {
    process.env["AIDE_ISSUE_DECK_URL"] = "https://deck.example.test/";
    process.env["SHARED_TOKEN_API_SECRET"] = "shared-secret";
    resetSharedTokenCacheForTest();
    // 共有トークンはキャッシュへ先に入れておく（以降のfetchはサマリーAPIだけになる）。
    await getSharedToken("ISSUE_DECK_DEVELOPMENT_SUMMARY_TOKEN", "aide", { fetchImpl: async () => Response.json({ name: "X", value: TOKEN }) });
  });
  afterEach(() => {
    mock.restoreAll();
    delete process.env["AIDE_ISSUE_DECK_URL"];
    delete process.env["SHARED_TOKEN_API_SECRET"];
  });

  it("未設定なら送信せず not_configured（0件にしない）", async () => {
    resetSharedTokenCacheForTest();
    delete process.env["SHARED_TOKEN_API_SECRET"];
    const fetchMock = mock.method(globalThis, "fetch", async () => new Response("{}"));
    const out = parsed(await summary());
    assert.equal(out["status"], "not_configured");
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  it("GETでBearer付きに送り、応答を加工せず data に入れる", async () => {
    const body = { schemaVersion: 1, complete: false, stale: true, totals: { notStarted: { issues: 3 } } };
    const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      assert.equal(url.origin + url.pathname, "https://deck.example.test/api/integrations/aide/development-summary");
      assert.equal(url.searchParams.get("repositoryFullName"), "guchi-apps/aide");
      assert.equal(init?.method, "GET");
      assert.equal((init?.headers as Record<string, string>)["Authorization"], `Bearer ${TOKEN}`);
      return Response.json(body);
    });
    const result = await summary({ repo: "guchi-apps/aide" });
    const out = parsed(result);
    assert.equal(out["status"], "ok");
    assert.deepEqual(out["data"], body);
    assert.equal(fetchMock.mock.callCount(), 1);
    assert.ok(!result.content[0]!.text.includes(TOKEN));
  });

  it("items は別パスへ category・cursor・limit を渡す", async () => {
    mock.method(globalThis, "fetch", async (input: string | URL) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/api/integrations/aide/development-items");
      assert.equal(url.searchParams.get("category"), "reserved");
      assert.equal(url.searchParams.get("cursor"), "c1");
      assert.equal(url.searchParams.get("limit"), "20");
      return Response.json({ schemaVersion: 1, items: [], nextCursor: null });
    });
    assert.equal(parsed(await items({ category: "reserved", cursor: "c1", limit: 20 }))["status"], "ok");
  });

  it("引数不正はIssueDeckへ送らない", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => Response.json({ schemaVersion: 1 }));
    assert.equal(parsed(await items({}))["status"], "invalid_arguments");
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  for (const [httpStatus, status] of [[401, "unauthorized"], [403, "forbidden"], [400, "bad_request"], [500, "unavailable"]] as const) {
    it(`HTTP ${httpStatus} は ${status} として返し、応答本文を出さない`, async () => {
      mock.method(globalThis, "fetch", async () => new Response("secret-body-detail", { status: httpStatus }));
      const result = await summary();
      const out = parsed(result);
      assert.equal(out["status"], status);
      assert.equal(out["httpStatus"], httpStatus);
      assert.ok(!result.content[0]!.text.includes("secret-body-detail"));
      assert.equal(out["data"], undefined);
    });
  }

  it("タイムアウト・接続失敗・不正JSON・schemaVersion欠落は ok にしない", async () => {
    mock.method(globalThis, "fetch", async () => {
      throw new DOMException("t", "TimeoutError");
    });
    assert.equal(parsed(await summary())["status"], "timeout");
    mock.restoreAll();

    mock.method(globalThis, "fetch", async () => {
      throw new Error("connect ECONNREFUSED https://internal.example");
    });
    const refused = await summary();
    assert.equal(parsed(refused)["status"], "unavailable");
    assert.ok(!refused.content[0]!.text.includes("internal.example"));
    mock.restoreAll();

    mock.method(globalThis, "fetch", async () => new Response("<html>"));
    assert.equal(parsed(await summary())["status"], "invalid_response");
    mock.restoreAll();

    mock.method(globalThis, "fetch", async () => Response.json({ totals: {} }));
    assert.equal(parsed(await summary())["status"], "invalid_response");
  });
});
