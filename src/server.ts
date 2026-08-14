import { createServer } from "node:http";
import { McpTransport } from "./mcp/transport.ts";
import { ToolRegistry } from "./mcp/registry.ts";
import { pingTool } from "./mcp/tools/ping.ts";

/**
 * AIDE のエントリポイント。
 *
 * MCPサーバー（/mcp）とREST API（/api）を1プロセスで提供する。
 * VPSのメモリが2GBしかなく、常駐プロセスを増やしたくないため意図的に分けていない。
 * Playwright等の重い取得処理はここではなく worker 側で動かし、結果をキャッシュ経由で読む。
 */

const PORT = Number(process.env["PORT"] ?? 4747);
const HOST = process.env["HOST"] ?? "127.0.0.1";

const registry = new ToolRegistry();
registry.register(pingTool);

const mcp = new McpTransport(registry, { name: "aide", version: "0.1.0" });

const server = createServer((req, res) => {
  const path = new URL(req.url ?? "/", `http://${HOST}:${PORT}`).pathname;

  if (path === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" }).end("ok\n");
    return;
  }
  if (path === "/mcp") {
    void mcp.handle(req, res).catch((cause: unknown) => {
      console.error("[mcp] 未処理の例外", cause);
      if (!res.headersSent) res.writeHead(500).end();
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" }).end("not found\n");
});

server.listen(PORT, HOST, () => {
  console.log(`AIDE listening on http://${HOST}:${PORT} (mcp: /mcp)`);
});
