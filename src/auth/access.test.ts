import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  createAccessClient,
  defaultFetcher,
  parseAccessResponse,
  type AccessFetcher,
  type AccessSubject,
} from "./access.ts";
import { resetSharedTokenCacheForTest } from "../core/connectors/issue-deck/shared-tokens.ts";

const SUBJECT: AccessSubject = { sub: "user-1", email: "me@example.com", emailVerified: true };

function body(allowed: boolean, appVersion = 1) {
  return {
    appVersion,
    ttlSeconds: 30,
    maxStaleSeconds: 300,
    decision: { allowed, permissions: allowed ? ["viewer"] : [] },
  };
}

describe("判定APIの応答の読み取り", () => {
  it("正しい応答を読む", () => {
    assert.deepEqual(parseAccessResponse(body(true), true).decision, { allowed: true, permissions: ["viewer"] });
  });

  it("判定が必要なのに無い応答・形の違う応答は失敗にする", () => {
    assert.throws(() => parseAccessResponse({ ...body(true), decision: undefined }, true));
    assert.throws(() => parseAccessResponse({ ...body(true), ttlSeconds: 0 }, true));
    assert.throws(() => parseAccessResponse(null, true));
  });

  it("ハートビートの応答は判定が無くてよい", () => {
    assert.equal(parseAccessResponse({ ...body(true), decision: undefined }, false).decision, null);
  });
});

describe("アクセス判定のクライアント", () => {
  it("TTLの間は再問い合わせせず、過ぎたら取り直す（取り消しが効く）", async () => {
    let time = 0;
    let allowed = true;
    let calls = 0;
    const fetcher: AccessFetcher = async () => {
      calls += 1;
      return parseAccessResponse(body(allowed), true);
    };
    const client = createAccessClient(fetcher, () => time);

    assert.equal((await client.decide(SUBJECT)).allowed, true);
    allowed = false;
    time = 29_000;
    assert.equal((await client.decide(SUBJECT)).allowed, true);
    assert.equal(calls, 1);
    time = 31_000;
    assert.equal((await client.decide(SUBJECT)).allowed, false);
    assert.equal(calls, 2);
  });

  it("取得に失敗したら、直前の判定を5分までだけ使い、超えたら拒否する", async () => {
    let time = 0;
    let fail = false;
    const fetcher: AccessFetcher = async () => {
      if (fail) throw new Error("HTTP 503");
      return parseAccessResponse(body(true), true);
    };
    const client = createAccessClient(fetcher, () => time);

    assert.equal((await client.decide(SUBJECT)).allowed, true);
    fail = true;
    time = 120_000;
    assert.equal((await client.decide(SUBJECT)).allowed, true);
    time = 301_000;
    assert.equal((await client.decide(SUBJECT)).allowed, false);
  });

  it("一度も判定できていない利用者は、取得に失敗したら拒否する", async () => {
    const client = createAccessClient(async () => {
      throw new Error("timeout");
    });
    assert.equal((await client.decide(SUBJECT)).allowed, false);
  });

  it("確認済みでないメール・IDの無い主体は、問い合わせずに拒否する", async () => {
    let calls = 0;
    const client = createAccessClient(async () => {
      calls += 1;
      return parseAccessResponse(body(true), true);
    });
    assert.equal((await client.decide({ ...SUBJECT, emailVerified: false })).allowed, false);
    assert.equal((await client.decide({ ...SUBJECT, sub: "" })).allowed, false);
    assert.equal(calls, 0);
  });

  it("2回目以降の問い合わせとハートビートで、適用中の版を申告する", async () => {
    const sent: unknown[] = [];
    const client = createAccessClient(async (request) => {
      sent.push(request);
      return parseAccessResponse(body(true, 7), request.subject !== undefined);
    });
    await client.decide(SUBJECT);
    assert.equal(await client.heartbeat(), true);
    assert.equal((sent[0] as { appliedVersion?: number }).appliedVersion, undefined);
    assert.deepEqual(sent[1], { appliedVersion: 7 });
  });

  it("ハートビートが失敗したら false を返し、例外にしない", async () => {
    const client = createAccessClient(async () => {
      throw new Error("down");
    });
    assert.equal(await client.heartbeat(), false);
  });
});

describe("defaultFetcher の共有トークン取得（aide#665）", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    delete process.env["AIDE_ISSUE_DECK_URL"];
    delete process.env["SHARED_TOKEN_API_SECRET"];
    globalThis.fetch = originalFetch;
    resetSharedTokenCacheForTest();
  });

  it("AIDE_ACCESS_APP_TOKEN を利用元 aide として取得し、判定APIへ Bearer で送る", async () => {
    process.env["AIDE_ISSUE_DECK_URL"] = "https://deck.example.test";
    process.env["SHARED_TOKEN_API_SECRET"] = "shared-token-api-secret";
    const consumers: string[] = [];
    let decisionAuth = "";
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (String(url).startsWith("https://deck.example.test/api/shared-tokens")) {
        assert.equal(String(url), "https://deck.example.test/api/shared-tokens?name=AIDE_ACCESS_APP_TOKEN");
        consumers.push(headers["X-Shared-Token-Consumer"] ?? "");
        return new Response(JSON.stringify({ name: "AIDE_ACCESS_APP_TOKEN", value: "app-token" }), { status: 200 });
      }
      decisionAuth = headers["Authorization"] ?? "";
      return new Response(JSON.stringify({ appVersion: 1, ttlSeconds: 30, maxStaleSeconds: 300 }), { status: 200 });
    }) as typeof fetch;

    await defaultFetcher({ appliedVersion: 0 });
    assert.deepEqual(consumers, ["aide"]);
    assert.equal(decisionAuth, "Bearer app-token");
  });
});
