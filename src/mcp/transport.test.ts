import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, beforeEach, describe, it } from "node:test";
import type { McpAccessEntry } from "./access-log.ts";

// 記録の置き場を差し替えてから読み込む（access-log.test.ts と同じ理由）。
const dir = await mkdtemp(join(tmpdir(), "aide-mcp-transport-test-"));
process.env["AIDE_MCP_ACCESS_LOG_PATH"] = join(dir, "mcp-access.json");
const { readMcpAccessLog, resetMcpAccessLog } = await import("./access-log.ts");
const { ToolRegistry } = await import("./registry.ts");
const { McpTransport } = await import("./transport.ts");

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  resetMcpAccessLog();
});

/**
 * 応答を捨てる受け口。transport が使うのは `writeHead().end()` だけなので、
 * 本物のHTTPサーバーを立てずに済ませる。
 */
function response(): ServerResponse & {
  status: number;
  body: string;
  headers: Record<string, string>;
} {
  const res = {
    status: 0,
    body: "",
    headers: {} as Record<string, string>,
    writeHead(status: number, headers: Record<string, string> = {}) {
      res.status = status;
      res.headers = headers;
      return res;
    },
    end(body?: string) {
      res.body = body ?? "";
      return res;
    },
  };
  return res as unknown as ServerResponse & {
    status: number;
    body: string;
    headers: Record<string, string>;
  };
}

function request(body: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const stream = Readable.from([Buffer.from(JSON.stringify(body), "utf8")]) as unknown as {
    method: string;
    headers: Record<string, string>;
  };
  stream.method = "POST";
  stream.headers = { "content-type": "application/json", ...headers };
  return stream as unknown as IncomingMessage;
}

/** テストから見たAIDEの公開URL。本番では `resolveBaseUrl()` が返すものが入る。 */
const BASE_URL = "https://aide.example";

function transport(): InstanceType<typeof McpTransport> {
  const registry = new ToolRegistry();
  registry.register({
    name: "aide_ok",
    description: "成功するツール",
    inputSchema: { type: "object" },
    handler: () => ({ content: [{ type: "text" as const, text: "ok" }] }),
  });
  registry.register({
    name: "aide_boom",
    description: "失敗するツール",
    inputSchema: { type: "object" },
    handler: () => {
      throw new Error("外部サービスが落ちている");
    },
  });
  return new McpTransport(registry, { name: "aide", version: "test" });
}

/** 記録は応答を待たせないよう投げっぱなしにしてあるので、揃うまで待つ。 */
async function waitForEntries(count: number): Promise<McpAccessEntry[]> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const entries = await readMcpAccessLog();
    if (entries.length >= count) return entries;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`記録が ${count} 件に届かなかった`);
}

describe("MCPのやり取りの記録", () => {
  it("ツールの呼び出しを、ツール名つきで残す", async () => {
    await transport().handle(
      request({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "aide_ok" } }),
      response(),
      BASE_URL,
    );

    const [entry] = await waitForEntries(1);
    assert.equal(entry?.method, "tools/call");
    assert.equal(entry?.tool, "aide_ok");
    assert.equal(entry?.ok, true);
  });

  it("ツールの失敗を失敗として残す（プロトコルエラーにならない経路）", async () => {
    // ツールが投げた例外は isError 付きの「成功レスポンス」で返る。
    // 応答の error だけを見ると、ツールが全滅していても失敗0件になる。
    const res = response();
    await transport().handle(
      request({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "aide_boom" } }),
      res,
      BASE_URL,
    );
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('"isError":true'));

    const [entry] = await waitForEntries(1);
    assert.equal(entry?.ok, false);
    assert.ok(entry?.detail.includes("外部サービスが落ちている"), entry?.detail);
  });

  it("未知のツールもツール名つきで残す", async () => {
    await transport().handle(
      request({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "aide_missing" } }),
      response(),
      BASE_URL,
    );

    const [entry] = await waitForEntries(1);
    assert.equal(entry?.tool, "aide_missing");
    assert.equal(entry?.ok, false);
    assert.ok(entry?.detail.includes("未知のツール"));
  });

  it("名乗ったクライアント名を、以降のリクエストにも引き継ぐ", async () => {
    // 名乗りは initialize の1回だけ来る。ここで覚えておかないと、
    // 以降のツール呼び出しが全部「不明」になる。
    const mcp = transport();
    const res = response();
    await mcp.handle(
      request({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", clientInfo: { name: "Claude", version: "1.4.2" } },
      }),
      res,
      BASE_URL,
    );
    const sessionId = res.headers["Mcp-Session-Id"]!;
    assert.ok(sessionId, "セッションIDが発行されていない");

    await mcp.handle(
      request(
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "aide_ok" } },
        { "mcp-session-id": sessionId },
      ),
      response(),
      BASE_URL,
    );

    const entries = await waitForEntries(2);
    assert.deepEqual(
      entries.map((entry) => [entry.method, entry.client, entry.clientVersion]),
      [
        ["initialize", "Claude", "1.4.2"],
        ["tools/call", "Claude", "1.4.2"],
      ],
    );
  });

  it("名乗らない相手は User-Agent で代用する", async () => {
    await transport().handle(
      request({ jsonrpc: "2.0", id: 1, method: "ping" }, { "user-agent": "Anthropic/Toolbox 2.0" }),
      response(),
      BASE_URL,
    );

    const [entry] = await waitForEntries(1);
    assert.equal(entry?.client, "Anthropic/Toolbox");
    assert.equal(entry?.clientVersion, null);
  });

  it("セッションIDとツールの引数は記録に残さない", async () => {
    const res = response();
    await transport().handle(
      request({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "aide_ok", arguments: { secret: "この文字列は残ってはいけない" } },
      }),
      res,
      BASE_URL,
    );

    const [entry] = await waitForEntries(1);
    assert.ok(!JSON.stringify(entry).includes("この文字列は残ってはいけない"));
    assert.ok(!Object.keys(entry!).includes("sessionId"));
  });
});

describe("initialize が名乗る内容", () => {
  it("アイコンを同一オリジンの絶対URLで返す", async () => {
    // クライアントは資格情報なしでアイコンを取りに行き、サーバーと別オリジンのURLは
    // 拒否してよいことになっている。相対パスや別ホストになっていないかを確かめる。
    const res = response();
    await transport().handle(
      request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      res,
      BASE_URL,
    );

    const { result } = JSON.parse(res.body) as {
      result: { serverInfo: { icons?: { src: string; mimeType: string; sizes: string[] }[] } };
    };
    const icons = result.serverInfo.icons ?? [];
    assert.ok(icons.length > 0, "アイコンを名乗っていない");
    for (const icon of icons) {
      assert.ok(icon.src.startsWith(`${BASE_URL}/icons/`), icon.src);
      assert.equal(icon.mimeType, "image/png");
      assert.match(icon.sizes[0]!, /^\d+x\d+$/);
    }
  });
});
