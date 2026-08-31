import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { researchDeskImportWeeklyReportTool } from "./research-desk.ts";

const URL_ENV = "AIDE_RESEARCH_DESK_URL";
const TOKEN_ENV = "AIDE_RESEARCH_DESK_TOKEN";
const SECRET = "test-research-desk-secret";

const tool = researchDeskImportWeeklyReportTool;

function parsed(result: Awaited<ReturnType<typeof tool.handler>>): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

function args(articles?: Record<string, unknown>[]): Record<string, unknown> {
  return {
    executedAt: "2026-08-30T18:00:00+09:00",
    targetFrom: "2026-08-23T18:00:00+09:00",
    targetTo: "2026-08-30T18:00:00+09:00",
    articles: articles ?? [
      {
        business: "DELIVERY",
        informationType: "MARKET_STATISTICS",
        title: "宅配便取扱個数の統計が公表された",
        url: "https://news.example.test/articles/1",
        sourceName: "物流ニュース",
      },
      {
        business: "LOCKER",
        informationType: "NEW_PRODUCT",
        title: "新型宅配ロッカーが発表された",
        url: "https://news.example.test/articles/2",
        sourceName: "ロッカー業界紙",
      },
    ],
  };
}

const importResult = {
  runId: "run-1",
  status: "SUCCEEDED",
  insertedCount: 1,
  duplicateCount: 1,
  failedCount: 0,
  businessCounts: { DELIVERY: 1, LOCKER: 1 },
  duplicateBusinessCounts: { DELIVERY: 0, LOCKER: 1 },
  errors: [],
};

function withEnv<T>(run: () => T): T {
  const previousUrl = process.env[URL_ENV];
  const previousToken = process.env[TOKEN_ENV];
  process.env[URL_ENV] = "https://research.example.test";
  process.env[TOKEN_ENV] = SECRET;
  try {
    return run();
  } finally {
    if (previousUrl === undefined) delete process.env[URL_ENV];
    else process.env[URL_ENV] = previousUrl;
    if (previousToken === undefined) delete process.env[TOKEN_ENV];
    else process.env[TOKEN_ENV] = previousToken;
  }
}

describe("aide_research_desk_import_weekly_report", () => {
  it("書き込みツールとして必要な入力を必須にする", () => {
    assert.deepEqual(tool.inputSchema["required"], ["executedAt", "targetFrom", "targetTo", "articles"]);
    const properties = tool.inputSchema["properties"] as Record<string, Record<string, unknown>>;
    assert.equal(properties["articles"]?.["maxItems"], 6);
    assert.match(tool.description, /書き込みツール/);
    // 認証情報はサーバー側の設定から決まる。引数として受け取らない。
    assert.deepEqual(Object.keys(properties).sort(), ["articles", "executedAt", "targetFrom", "targetTo"]);
  });

  it("Research Deskの内部APIへ送り、件数と実行IDを返す", async () => {
    await withEnv(async () => {
      const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
        assert.equal(input, "https://research.example.test/api/internal/weekly-report");
        assert.equal(init?.method, "POST");
        assert.equal((init?.headers as Record<string, string>)["Authorization"], `Bearer ${SECRET}`);
        return new Response(JSON.stringify(importResult), { status: 200, headers: { "content-type": "application/json" } });
      });
      try {
        const payload = parsed(await tool.handler(args(), { sessionId: null }));
        assert.equal(payload["ok"], true);
        assert.equal(payload["status"], "SUCCEEDED");
        assert.equal(payload["runId"], "run-1");
        assert.equal(payload["duplicateCount"], 1);
        assert.deepEqual(payload["businessCounts"], { DELIVERY: 1, LOCKER: 1 });
      } finally {
        fetchMock.mock.restore();
      }
    });
  });

  it("入力が不正なら外部へ送らずINVALID_REQUESTを返す", async () => {
    await withEnv(async () => {
      const fetchMock = mock.method(globalThis, "fetch", async () => {
        throw new Error("送信してはいけない");
      });
      try {
        const payload = parsed(await tool.handler(args([]), { sessionId: null }));
        assert.equal(payload["ok"], false);
        assert.equal(payload["status"], "INVALID_REQUEST");
        assert.equal(fetchMock.mock.callCount(), 0);
      } finally {
        fetchMock.mock.restore();
      }
    });
  });

  it("未設定なら外部へ送らず失敗理由を返す", async () => {
    const previousUrl = process.env[URL_ENV];
    const previousToken = process.env[TOKEN_ENV];
    delete process.env[URL_ENV];
    delete process.env[TOKEN_ENV];
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      throw new Error("送信してはいけない");
    });
    try {
      const payload = parsed(await tool.handler(args(), { sessionId: null }));
      assert.equal(payload["ok"], false);
      assert.equal(payload["status"], "FAILED");
      assert.match(String(payload["reason"]), /未設定/);
      assert.equal(fetchMock.mock.callCount(), 0);
    } finally {
      fetchMock.mock.restore();
      if (previousUrl !== undefined) process.env[URL_ENV] = previousUrl;
      if (previousToken !== undefined) process.env[TOKEN_ENV] = previousToken;
    }
  });
});
