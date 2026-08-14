import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ToolRegistry } from "./registry.ts";
import {
  DEFAULT_PROTOCOL,
  RpcError,
  SUPPORTED_PROTOCOLS,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./types.ts";

/**
 * MCP Streamable HTTP transport。
 *
 * Claudeアプリの実測（2026-08-14）で判明した前提:
 * - 接続元はAnthropicのサーバー。利用者の端末からではないため公開到達性が要る。
 * - 接続時に OAuth ディスカバリを3パス叩いてくるが、404でも無認証で継続する。
 * - `Anthropic/Toolbox` と `Anthropic/ClaudeAI` が別セッションで同時に繋いでくる。
 */

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
  "Access-Control-Max-Age": "86400",
};

export interface McpServerInfo {
  name: string;
  version: string;
}

interface RpcContext {
  sessionId: string | null;
  /** initialize で新規発行したセッションID。レスポンスヘッダに載せる。 */
  issuedSessionId: string | null;
}

export class McpTransport {
  readonly #registry: ToolRegistry;
  readonly #serverInfo: McpServerInfo;
  readonly #sessions = new Set<string>();

  constructor(registry: ToolRegistry, serverInfo: McpServerInfo) {
    this.#registry = registry;
    this.#serverInfo = serverInfo;
  }

  /** MCPエンドポイントへのリクエストを処理する。パスの振り分けは呼び出し側の責務。 */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    switch (req.method) {
      case "OPTIONS":
        res.writeHead(204, CORS_HEADERS).end();
        return;
      case "GET":
        this.#handleServerStream(req, res);
        return;
      case "DELETE": {
        const sessionId = req.headers["mcp-session-id"];
        if (typeof sessionId === "string") this.#sessions.delete(sessionId);
        res.writeHead(204, CORS_HEADERS).end();
        return;
      }
      case "POST":
        await this.#handlePost(req, res);
        return;
      default:
        res.writeHead(405, { Allow: "GET, POST, DELETE, OPTIONS", ...CORS_HEADERS }).end();
    }
  }

  /**
   * サーバー起点SSE。現状こちらから送るものは無いが、接続を維持して互換性を確保する。
   * 405を返してもClaudeは動作するが、将来の通知配信のために開けておく。
   */
  #handleServerStream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      ...CORS_HEADERS,
    });
    res.write(": connected\n\n");
    const keepalive = setInterval(() => res.write(": keepalive\n\n"), 15_000);
    req.on("close", () => clearInterval(keepalive));
  }

  async #handlePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let payload: unknown;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      this.#send(res, 400, {}, {
        jsonrpc: "2.0",
        id: 0,
        error: { code: RpcError.ParseError, message: "Parse error" },
      });
      return;
    }

    const sessionHeader = req.headers["mcp-session-id"];
    const ctx: RpcContext = {
      sessionId: typeof sessionHeader === "string" ? sessionHeader : null,
      issuedSessionId: null,
    };

    // 2025-03-26 以前はバッチを許容していた。単体で来ても配列で来ても扱えるようにする。
    const isBatch = Array.isArray(payload);
    const messages = (isBatch ? payload : [payload]) as JsonRpcRequest[];
    const responses: JsonRpcResponse[] = [];
    for (const message of messages) {
      const response = await this.#dispatch(message, ctx);
      if (response) responses.push(response);
    }

    const headers: Record<string, string> = {};
    if (ctx.issuedSessionId) headers["Mcp-Session-Id"] = ctx.issuedSessionId;

    // 通知のみのリクエストは返す本体が無い。202 を返すのが仕様。
    if (responses.length === 0) {
      res.writeHead(202, { ...CORS_HEADERS, ...headers }).end();
      return;
    }
    this.#send(res, 200, headers, isBatch ? responses : responses[0]!);
  }

  async #dispatch(
    message: JsonRpcRequest,
    ctx: RpcContext,
  ): Promise<JsonRpcResponse | null> {
    const { method, params, id } = message;
    const isNotification = id === undefined || id === null;
    const ok = (result: unknown): JsonRpcResponse | null =>
      isNotification ? null : { jsonrpc: "2.0", id: id!, result };
    const fail = (code: number, msg: string): JsonRpcResponse | null =>
      isNotification ? null : { jsonrpc: "2.0", id: id!, error: { code, message: msg } };

    switch (method) {
      case "initialize": {
        const requested = params?.["protocolVersion"];
        // クライアントが要求したバージョンに対応していればそれを使う。
        // 未知なら自分の最新を返す（Claudeはダウングレードを受け入れる）。
        const protocolVersion =
          typeof requested === "string" &&
          (SUPPORTED_PROTOCOLS as readonly string[]).includes(requested)
            ? requested
            : DEFAULT_PROTOCOL;
        ctx.issuedSessionId = randomUUID();
        this.#sessions.add(ctx.issuedSessionId);
        return ok({
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: this.#serverInfo,
        });
      }

      // 通知。応答不要。
      case "notifications/initialized":
      case "notifications/cancelled":
        return null;

      case "ping":
        return ok({});

      case "tools/list":
        return ok({ tools: this.#registry.list() });

      case "tools/call": {
        const name = params?.["name"];
        if (typeof name !== "string") {
          return fail(RpcError.InvalidParams, "params.name が必要です");
        }
        const tool = this.#registry.get(name);
        if (!tool) return fail(RpcError.InvalidParams, `未知のツール: ${name}`);

        const args = (params?.["arguments"] ?? {}) as Record<string, unknown>;
        try {
          return ok(await tool.handler(args, { sessionId: ctx.sessionId }));
        } catch (cause) {
          // ツールの失敗はプロトコルエラーではなく、isError付きの結果として返す。
          // そうしないとClaudeが復旧できない。
          const detail = cause instanceof Error ? cause.message : String(cause);
          return ok({
            content: [{ type: "text", text: `ツール ${name} が失敗しました: ${detail}` }],
            isError: true,
          });
        }
      }

      // 未実装だが問い合わせが来る。空で返す方が接続が安定する。
      case "resources/list":
        return ok({ resources: [] });
      case "prompts/list":
        return ok({ prompts: [] });

      default:
        return fail(RpcError.MethodNotFound, `未対応のメソッド: ${method}`);
    }
  }

  #send(
    res: ServerResponse,
    status: number,
    headers: Record<string, string>,
    body: unknown,
  ): void {
    res
      .writeHead(status, { "Content-Type": "application/json", ...CORS_HEADERS, ...headers })
      .end(JSON.stringify(body));
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
