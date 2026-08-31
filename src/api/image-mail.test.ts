import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

const dir = await mkdtemp(join(tmpdir(), "aide-image-mail-api-test-"));
process.env["AIDE_IMAGE_MAIL_IDEMPOTENCY_LOG_PATH"] = join(dir, "image-mail-idempotency.json");
process.env["AIDE_IMAGE_MAIL_LOG_PATH"] = join(dir, "image-mail-log.json");
const { handleImageMailSend } = await import("./image-mail.ts");
const { resetRateLimits } = await import("../auth/ratelimit.ts");

/**
 * **Gmailへ実際にリクエストが飛ぶ経路はここでは扱わない。**
 * 認証・メソッド・設定の有無・入力検査という、Gmailへ届く前に決まるところだけをテストする。
 * 送信本体（`sendImageMail`）は `core/connectors/image-mail/send.test.ts`。
 */

const TOKEN = "test-only-image-mail-token";
const BOUNDARY = "AideTestBoundary";

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const originalFetch = globalThis.fetch;

after(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  resetRateLimits();
  process.env["AIDE_IMAGE_MAIL_TOKEN"] = TOKEN;
  process.env["AIDE_GMAIL_CLIENT_ID"] = "id";
  process.env["AIDE_GMAIL_CLIENT_SECRET"] = "secret";
  process.env["AIDE_GMAIL_REFRESH_TOKEN"] = "token";
  process.env["AIDE_IMAGE_MAIL_TO"] = "to@example.com";
  process.env["AIDE_IMAGE_MAIL_BCC"] = "";
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

function buildMultipartBody(fields: Record<string, string>, file?: { name: string; filename: string; contentType: string; data: Buffer }): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, "utf8"));
  }
  if (file) {
    chunks.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
        "utf8",
      ),
    );
    chunks.push(file.data);
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}

const VALID_ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02]);

function validBody(overrides: Partial<Record<string, string>> = {}): Buffer {
  return buildMultipartBody(
    {
      title: "テスト画像",
      imageCount: "3",
      width: "1200",
      idempotencyKey: "11111111-1111-1111-1111-111111111111",
      ...overrides,
    },
    { name: "zip", filename: "images.zip", contentType: "application/zip", data: VALID_ZIP },
  );
}

async function post(
  body: Buffer,
  { authorization = `Bearer ${TOKEN}`, contentType = `multipart/form-data; boundary=${BOUNDARY}` }: { authorization?: string | null; contentType?: string | null } = {},
): Promise<Captured> {
  const { res, captured } = fakeRes();
  await handleImageMailSend(fakeReq("POST", body, authorization, contentType), res);
  return captured;
}

describe("POST /api/image-mail/send", () => {
  it("GETは405", async () => {
    const { res, captured } = fakeRes();
    await handleImageMailSend(fakeReq("GET", Buffer.alloc(0), null, null), res);
    assert.equal(captured.status, 405);
  });

  it("AIDE_IMAGE_MAIL_TOKEN未設定なら503", async () => {
    delete process.env["AIDE_IMAGE_MAIL_TOKEN"];
    const result = await post(validBody());
    assert.equal(result.status, 503);
    assert.match(result.body, /AIDE_IMAGE_MAIL_TOKEN/);
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
    delete process.env["AIDE_IMAGE_MAIL_TO"];
    const result = await post(validBody());
    assert.equal(result.status, 503);
    assert.match(result.body, /AIDE_IMAGE_MAIL_TO/);
  });

  it("multipart/form-dataでなければ400", async () => {
    const result = await post(validBody(), { contentType: "application/json" });
    assert.equal(result.status, 400);
  });

  it("titleが201文字なら400", async () => {
    const result = await post(validBody({ title: "あ".repeat(201) }));
    assert.equal(result.status, 400);
  });

  it("widthが許可値以外なら400", async () => {
    const result = await post(validBody({ width: "800" }));
    assert.equal(result.status, 400);
  });

  it("imageCountが整数でなければ400", async () => {
    const result = await post(validBody({ imageCount: "abc" }));
    assert.equal(result.status, 400);
  });

  it("idempotencyKeyが空なら400", async () => {
    const result = await post(validBody({ idempotencyKey: "" }));
    assert.equal(result.status, 400);
  });

  it("zipが2MiB超なら400", async () => {
    const bigZip = Buffer.alloc(2 * 1024 * 1024 + 1, 1);
    const body = buildMultipartBody(
      { title: "test", imageCount: "1", width: "600", idempotencyKey: "big-zip-key" },
      { name: "zip", filename: "images.zip", contentType: "application/zip", data: bigZip },
    );
    const result = await post(body);
    assert.equal(result.status, 400);
  });

  it("zipが無ければ400", async () => {
    const body = buildMultipartBody({
      title: "test",
      imageCount: "1",
      width: "600",
      idempotencyKey: "no-zip-key",
    });
    const result = await post(body);
    assert.equal(result.status, 400);
  });

  it("正常系: subject項目を混ぜても無視され、[画像] {title}固定で送信が成功する", async () => {
    const result = await post(validBody({ subject: "改ざんしたい件名" }));
    assert.equal(result.status, 200);
    const parsed = JSON.parse(result.body) as { ok: boolean; messageId: string };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.messageId, "msg-mock");
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
