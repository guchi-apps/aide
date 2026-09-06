import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

const dir = await mkdtemp(join(tmpdir(), "aide-news-mail-api-test-"));
process.env["AIDE_NEWS_MAIL_IDEMPOTENCY_LOG_PATH"] = join(dir, "news-mail-idempotency.json");
process.env["AIDE_NEWS_MAIL_LOG_PATH"] = join(dir, "news-mail-log.json");
const { handleNewsMailSend } = await import("./news-mail.ts");
const { resetRateLimits } = await import("../auth/ratelimit.ts");

/**
 * **Gmailへ実際にリクエストが飛ぶ経路はここでは扱わない。**
 * 認証・メソッド・設定の有無・入力検査という、Gmailへ届く前に決まるところだけをテストする。
 * 送信本体（`sendNewsMail`）は `core/connectors/news-mail/send.test.ts`。
 */

const TOKEN = "test-only-news-mail-token";

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const originalFetch = globalThis.fetch;

after(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  resetRateLimits();
  process.env["AIDE_NEWS_MAIL_TOKEN"] = TOKEN;
  process.env["AIDE_GMAIL_CLIENT_ID"] = "id";
  process.env["AIDE_GMAIL_CLIENT_SECRET"] = "secret";
  process.env["AIDE_GMAIL_REFRESH_TOKEN"] = "token";
  process.env["AIDE_NEWS_MAIL_TO"] = "to@example.com";
  process.env["AIDE_NEWS_MAIL_BCC"] = "";
  process.env["AIDE_NEWS_MAIL_FROM"] = "";
  // Gmailへは実接続しない。token取得・送信のどちらも成功で応答する。
  globalThis.fetch = (async (url: string | URL) => {
    if (String(url).includes("oauth2.googleapis.com")) {
      return new Response(JSON.stringify({ access_token: "at" }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: "msg-mock" }), { status: 200 });
  }) as typeof fetch;
});

interface Captured {
  status: number;
  body: string;
}

function fakeRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: "" };
  const res = {
    writeHead(status: number) {
      captured.status = status;
      return res;
    },
    end(body?: string) {
      captured.body = body ?? "";
      return res;
    },
  };
  return { res: res as unknown as ServerResponse, captured };
}

function fakeReq(method: string, body: Buffer, authorization: string | null, contentType: string | null): IncomingMessage {
  const headers: Record<string, string> = {};
  if (authorization !== null) headers["authorization"] = authorization;
  if (contentType !== null) headers["content-type"] = contentType;
  return {
    method,
    headers,
    socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() {
      yield body;
    },
  } as unknown as IncomingMessage;
}

function validBody(overrides: Partial<Record<string, unknown>> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      idempotencyKey: "11111111-1111-1111-1111-111111111111",
      subject: "[業界ニュース] 2026-09-01の週報",
      bodyText: "テキスト本文",
      bodyHtml: "<table><tr><td>本文</td></tr></table>",
      articleCount: 12,
      ...overrides,
    }),
    "utf8",
  );
}

async function post(
  body: Buffer,
  { authorization = `Bearer ${TOKEN}`, contentType = "application/json" }: { authorization?: string | null; contentType?: string | null } = {},
): Promise<Captured> {
  const { res, captured } = fakeRes();
  await handleNewsMailSend(fakeReq("POST", body, authorization, contentType), res);
  return captured;
}

describe("POST /api/news-mail/send", () => {
  it("GETは405", async () => {
    const { res, captured } = fakeRes();
    await handleNewsMailSend(fakeReq("GET", Buffer.alloc(0), null, null), res);
    assert.equal(captured.status, 405);
  });

  it("AIDE_NEWS_MAIL_TOKEN未設定なら503", async () => {
    delete process.env["AIDE_NEWS_MAIL_TOKEN"];
    const result = await post(validBody());
    assert.equal(result.status, 503);
    assert.match(result.body, /AIDE_NEWS_MAIL_TOKEN/);
  });

  it("Authorizationが無ければ401、messageフィールドを持つ", async () => {
    const result = await post(validBody(), { authorization: null });
    assert.equal(result.status, 401);
    const parsed = JSON.parse(result.body) as { message: string };
    assert.equal(typeof parsed.message, "string");
    assert.equal("error" in JSON.parse(result.body), false);
  });

  it("トークンが違えば401", async () => {
    const result = await post(validBody(), { authorization: "Bearer wrong" });
    assert.equal(result.status, 401);
  });

  it("Gmail資格情報が未設定なら503", async () => {
    delete process.env["AIDE_GMAIL_CLIENT_ID"];
    const result = await post(validBody());
    assert.equal(result.status, 503);
    assert.match(result.body, /AIDE_GMAIL/);
  });

  it("宛先未設定なら503", async () => {
    delete process.env["AIDE_NEWS_MAIL_TO"];
    const result = await post(validBody());
    assert.equal(result.status, 503);
    assert.match(result.body, /AIDE_NEWS_MAIL_TO/);
  });

  it("application/jsonでなければ400", async () => {
    const result = await post(validBody(), { contentType: "text/plain" });
    assert.equal(result.status, 400);
  });

  it("不正なJSONなら400", async () => {
    const { res, captured } = fakeRes();
    await handleNewsMailSend(fakeReq("POST", Buffer.from("{invalid"), `Bearer ${TOKEN}`, "application/json"), res);
    assert.equal(captured.status, 400);
  });

  it("idempotencyKeyが空なら400", async () => {
    const result = await post(validBody({ idempotencyKey: "" }));
    assert.equal(result.status, 400);
  });

  it("idempotencyKeyが201文字なら400", async () => {
    const result = await post(validBody({ idempotencyKey: "a".repeat(201) }));
    assert.equal(result.status, 400);
  });

  it("subjectが空なら400", async () => {
    const result = await post(validBody({ subject: "" }));
    assert.equal(result.status, 400);
  });

  it("subjectに改行を含むなら400", async () => {
    const result = await post(validBody({ subject: "件名\r\nBcc: leak@example.com" }));
    assert.equal(result.status, 400);
  });

  it("bodyTextが無ければ400", async () => {
    const result = await post(validBody({ bodyText: "" }));
    assert.equal(result.status, 400);
  });

  it("bodyHtmlが無ければ400", async () => {
    const result = await post(validBody({ bodyHtml: "" }));
    assert.equal(result.status, 400);
  });

  it("articleCountが整数でなければ400", async () => {
    const result = await post(validBody({ articleCount: "abc" }));
    assert.equal(result.status, 400);
  });

  it("articleCountが負の数なら400", async () => {
    const result = await post(validBody({ articleCount: -1 }));
    assert.equal(result.status, 400);
  });

  it("正常系: リクエストのsubjectがそのまま使われ送信が成功する", async () => {
    let raw: string | null = null;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes("oauth2.googleapis.com")) {
        return new Response(JSON.stringify({ access_token: "at" }), { status: 200 });
      }
      const payload = JSON.parse(String(init?.body)) as { raw: string };
      raw = Buffer.from(payload.raw, "base64url").toString("utf8");
      return new Response(JSON.stringify({ id: "msg-mock" }), { status: 200 });
    }) as typeof fetch;

    const result = await post(validBody());
    assert.equal(result.status, 200);
    const parsed = JSON.parse(result.body) as { ok: boolean; messageId: string };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.messageId, "msg-mock");
    assert.ok(raw);
    assert.ok(
      raw.includes(`Subject: =?UTF-8?B?${Buffer.from("[業界ニュース] 2026-09-01の週報", "utf8").toString("base64")}?=`),
    );
  });

  it("同じidempotencyKeyで再送するとduplicated:trueを返す", async () => {
    const first = await post(validBody({ idempotencyKey: "dup-key" }));
    assert.equal(first.status, 200);
    const second = await post(validBody({ idempotencyKey: "dup-key" }));
    assert.equal(second.status, 200);
    const parsed = JSON.parse(second.body) as { duplicated: boolean };
    assert.equal(parsed.duplicated, true);
  });
});
