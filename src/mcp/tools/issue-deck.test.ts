import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import type { ToolResult } from "../types.ts";
import { issueDeckUploadImageTool } from "./issue-deck.ts";

const TOKEN = "test-upload-token";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString("base64");

function parsed(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}
const call = (args: Record<string, unknown>) => issueDeckUploadImageTool.handler(args, { sessionId: null });

describe("issue_deck_upload_image", () => {
  beforeEach(() => {
    process.env["AIDE_ISSUE_DECK_URL"] = "https://deck.example.test/";
    process.env["AIDE_ISSUE_DECK_UPLOAD_TOKEN"] = TOKEN;
  });
  afterEach(() => {
    mock.restoreAll();
    delete process.env["AIDE_ISSUE_DECK_URL"];
    delete process.env["AIDE_ISSUE_DECK_UPLOAD_TOKEN"];
  });

  it("未設定なら送信せず not_configured を返す", async () => {
    delete process.env["AIDE_ISSUE_DECK_UPLOAD_TOKEN"];
    const fetchMock = mock.method(globalThis, "fetch", async () => new Response("{}"));
    assert.equal(parsed(await call({ dataBase64: PNG, mimeType: "image/png" }))["status"], "not_configured");
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  it("Bearer付きでmultipart送信し、URLを返す", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
      assert.equal(input, "https://deck.example.test/api/issues/images");
      assert.equal(init?.method, "POST");
      assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
      const file = (init?.body as FormData).get("file") as File;
      assert.equal(file.type, "image/png");
      assert.equal(file.size, 11);
      return Response.json({ url: "http://127.0.0.1:3000/api/issues/images/x", filename: "0b7d2c1e-1111-4222-8333-444455556666.png" });
    });
    const out = parsed(await call({ dataBase64: `data:image/png;base64,${PNG}`, mimeType: "image/png" }));
    assert.equal(fetchMock.mock.callCount(), 1);
    assert.equal(out["status"], "uploaded");
    // 内部Hostで返ってきても、公開URLから組み立て直す。
    assert.equal(out["url"], "https://deck.example.test/api/issues/images/0b7d2c1e-1111-4222-8333-444455556666.png");
    assert.equal(JSON.stringify(out).includes(TOKEN), false);
  });

  it("dryRunは検査だけして送らない", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => new Response("{}"));
    const out = parsed(await call({ dataBase64: PNG, mimeType: "image/png", dryRun: true }));
    assert.equal(out["status"], "dry_run");
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  it("MIMEと中身が食い違う・base64でない・非対応形式は送らずに断る", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => new Response("{}"));
    for (const args of [
      { dataBase64: PNG, mimeType: "image/jpeg" },
      { dataBase64: "!!!", mimeType: "image/png" },
      { dataBase64: PNG, mimeType: "text/html" },
      { dataBase64: Buffer.from("<html></html>").toString("base64"), mimeType: "image/svg+xml" },
    ]) {
      assert.equal(parsed(await call(args))["status"], "error");
    }
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  it("SVGは<svg>を含めば受け付ける", async () => {
    mock.method(globalThis, "fetch", async () => Response.json({ url: "u", filename: "0b7d2c1e-1111-4222-8333-444455556666.svg" }));
    const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64");
    assert.equal(parsed(await call({ dataBase64: svg, mimeType: "image/svg+xml" }))["status"], "uploaded");
  });

  it("10MBを超える入力は送らずに断る", async () => {
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 1);
    big[0] = 0xff; big[1] = 0xd8; big[2] = 0xff;
    const out = parsed(await call({ dataBase64: big.toString("base64"), mimeType: "image/jpeg" }));
    assert.equal(out["status"], "error");
  });

  it("IssueDeckが401を返したら isError で失敗を返す", async () => {
    mock.method(globalThis, "fetch", async () => new Response("{}", { status: 401 }));
    const result = await call({ dataBase64: PNG, mimeType: "image/png" });
    assert.equal(result.isError, true);
    assert.equal(parsed(result)["httpStatus"], 401);
  });

  it("通信失敗でも isError で返し、URLを漏らさない", async () => {
    mock.method(globalThis, "fetch", async () => { throw new TypeError("fetch failed https://deck.example.test"); });
    const result = await call({ dataBase64: PNG, mimeType: "image/png" });
    assert.equal(result.isError, true);
    assert.equal(result.content[0]!.text.includes("deck.example.test"), false);
  });
});
