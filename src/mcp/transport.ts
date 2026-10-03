import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mcpIcons } from "../web/assets.ts";
import { MAX_CLIENT_LENGTH, recordMcpAccess, shortUserAgent } from "./access-log.ts";
import type { ToolRegistry } from "./registry.ts";
import {
  DEFAULT_PROTOCOL,
  RpcError,
  SUPPORTED_PROTOCOLS,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type ToolResult,
} from "./types.ts";

/**
 * MCP Streamable HTTP transport。
 *
 * Claudeアプリの実測（2026-08-14）で判明した前提:
 * - 接続元はAnthropicのサーバー。利用者の端末からではないため公開到達性が要る。
 * - 接続時に OAuth ディスカバリを3パス叩いてくるが、404でも無認証で継続する。
 * - `Anthropic/Toolbox` と `Anthropic/ClaudeAI` が別セッションで同時に繋いでくる。
 */

/**
 * ツールの応答のうち、JSONとして読める text を整形なしへ直す。
 *
 * 各ツールは `JSON.stringify(payload, null, 2)` で返しており、インデントと改行だけで応答が
 * 2〜3割大きくなる（応答はモデルのコンテキストに入る。#489）。ツールごとに直すと足すたびに
 * 漏れるため、出口のここで揃える。値は変えない。JSONでない text（失敗メッセージなど）はそのまま。
 */
export function compactToolResult<T extends { content: { type: string; text: string }[] }>(result: T): T {
  return {
    ...result,
    content: result.content.map((item) => {
      if (item.type !== "text" || !/^\s*[{[]/.test(item.text)) return item;
      try {
        return { ...item, text: JSON.stringify(JSON.parse(item.text)) };
      } catch {
        return item;
      }
    }),
  };
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
  "Access-Control-Max-Age": "86400",
};

/**
 * POSTボディの上限。Bearer認証の後ろだが、本番のヒープは96MBしかなく、上限なしで読むと
 * 大きなPOST1本で使い切られる。JSON-RPCのツール呼び出しは数KBなので、1MiBあれば足りる。
 */
export const MAX_BODY_BYTES = 1024 * 1024;

/**
 * 覚えておくセッションの上限。`initialize` のたびに増え、`DELETE` されない限り消えないため、
 * ClaudeアプリやChatGPTが接続し直すたびに溜まる。超えたら古いものから忘れる。
 * セッションに持たせているのは記録に出す名前だけなので、忘れても動作は変わらない
 * （User-Agentでの代用に戻るだけ）。
 */
export const MAX_SESSIONS = 100;

export interface McpServerInfo {
  name: string;
  version: string;
}

interface RpcContext {
  sessionId: string | null;
  /** このリクエストから見たAIDEの公開URL。アイコンを絶対URLで名乗るのに使う。 */
  baseUrl: string;
  /** initialize で新規発行したセッションID。レスポンスヘッダに載せる。 */
  issuedSessionId: string | null;
  /**
   * 接続してきた相手。`initialize` で名乗った名前をセッションに覚えておき、
   * 以降のリクエストではそこから引く。名乗らない相手は User-Agent で代用する。
   */
  client: string | null;
  clientVersion: string | null;
}

/** セッションごとに覚えておくこと。**アクセスの記録に出す名前だけ**で、資格情報は持たない。 */
interface SessionInfo {
  client: string | null;
  clientVersion: string | null;
}

export class McpTransport {
  readonly #registry: ToolRegistry;
  readonly #serverInfo: McpServerInfo;
  readonly #sessions = new Map<string, SessionInfo>();

  constructor(registry: ToolRegistry, serverInfo: McpServerInfo) {
    this.#registry = registry;
    this.#serverInfo = serverInfo;
  }

  /**
   * MCPエンドポイントへのリクエストを処理する。パスの振り分けは呼び出し側の責務。
   * `baseUrl` は `initialize` で名乗るアイコンのURLに使う（`src/auth/config.ts` の
   * `resolveBaseUrl()` が返すもの）。
   */
  async handle(req: IncomingMessage, res: ServerResponse, baseUrl: string, scopes: readonly string[] = []): Promise<void> {
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
        await this.#handlePost(req, res, baseUrl, scopes);
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

  async #handlePost(req: IncomingMessage, res: ServerResponse, baseUrl: string, scopes: readonly string[]): Promise<void> {
    let payload: unknown;
    try {
      const body = await readBody(req);
      if (body === null) {
        this.#send(res, 413, { Connection: "close" }, {
          jsonrpc: "2.0",
          id: 0,
          error: { code: RpcError.InvalidRequest, message: `リクエストが大きすぎます（上限 ${MAX_BODY_BYTES} バイト）` },
        });
        return;
      }
      payload = JSON.parse(body);
    } catch {
      this.#send(res, 400, {}, {
        jsonrpc: "2.0",
        id: 0,
        error: { code: RpcError.ParseError, message: "Parse error" },
      });
      return;
    }

    const sessionHeader = req.headers["mcp-session-id"];
    const sessionId = typeof sessionHeader === "string" ? sessionHeader : null;
    const known = sessionId ? this.#sessions.get(sessionId) : undefined;
    const ctx: RpcContext = {
      sessionId,
      baseUrl,
      issuedSessionId: null,
      // 名乗りは initialize の1回だけ来る。以降のリクエストはセッションから引き、
      // それも無ければ User-Agent（`Anthropic/ClaudeAI` など）で代用する。
      client: known?.client ?? shortUserAgent(req.headers["user-agent"]),
      clientVersion: known?.clientVersion ?? null,
    };

    // 2025-03-26 以前はバッチを許容していた。単体で来ても配列で来ても扱えるようにする。
    const isBatch = Array.isArray(payload);
    const messages = (isBatch ? payload : [payload]) as JsonRpcRequest[];
    const responses: JsonRpcResponse[] = [];
    for (const message of messages) {
      const startedAt = Date.now();
      const response = await this.#dispatch(message, ctx, scopes);
      // 記録は待たない。ディスクへの書き込みでMCPの応答を遅らせる理由が無く、
      // 失敗しても応答は変わらない（src/mcp/access-log.ts）。
      void recordMcpAccess({
        at: new Date().toISOString(),
        method: typeof message?.method === "string" ? message.method : "(不明)",
        tool: message?.method === "tools/call" && typeof message.params?.["name"] === "string"
          ? (message.params["name"] as string)
          : null,
        client: ctx.client,
        clientVersion: ctx.clientVersion,
        ms: Date.now() - startedAt,
        ...outcome(response),
      });
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
    scopes: readonly string[],
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
        // 名乗りは記録に出す名前としてだけ使う。`clientInfo` は相手の自己申告で、
        // 権限の判断には使わない（それはアクセストークンの仕事）。
        const info = params?.["clientInfo"] as { name?: unknown; version?: unknown } | undefined;
        if (typeof info?.name === "string" && info.name.trim()) {
          ctx.client = info.name.trim().slice(0, MAX_CLIENT_LENGTH);
          ctx.clientVersion =
            typeof info.version === "string" && info.version.trim()
              ? info.version.trim().slice(0, MAX_CLIENT_LENGTH)
              : null;
        }
        // ネゴシエート結果を1行だけ残す。`serverInfo.icons` のような**新しい版で足された
        // フィールドは、相手が古い版で繋いでいると読まれない**（#125）。アクセスの記録に
        // プロトコル版は持たせていないため、出ない原因を切り分ける手掛かりがここしかない。
        console.log(
          `[mcp] initialize: protocol=${protocolVersion} client=${ctx.client ?? "(不明)"}`,
        );
        ctx.issuedSessionId = randomUUID();
        this.#sessions.set(ctx.issuedSessionId, {
          client: ctx.client,
          clientVersion: ctx.clientVersion,
        });
        // Map は挿入順を保つので、先頭が最も古い。
        while (this.#sessions.size > MAX_SESSIONS) {
          this.#sessions.delete(this.#sessions.keys().next().value!);
        }
        return ok({
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          // アイコンは 2025-11-25 で追加されたが、それより前のプロトコルで繋いできた
          // クライアントも知らないフィールドは無視するだけなので、出し分けない。
          serverInfo: { ...this.#serverInfo, icons: mcpIcons(ctx.baseUrl) },
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
        const missing = tool.requiredScopes?.filter((scope) => !scopes.includes(scope)) ?? [];
        if (missing.length > 0) {
          return ok({
            content: [{ type: "text", text: `ツール ${name} には ${missing.join(" ")} の認可が必要です。再接続して明示的に許可してください。` }],
            isError: true,
          });
        }

        const args = (params?.["arguments"] ?? {}) as Record<string, unknown>;
        try {
          return ok(compactToolResult(await tool.handler(args, { sessionId: ctx.sessionId, scopes })));
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

/**
 * 応答から成否と理由を取る。
 *
 * **ツールの失敗はプロトコルエラーにならない。** `#dispatch` が `isError` 付きの結果へ
 * 畳んでいるため（そうしないとClaudeが復旧できない）、そこも見ないと失敗を見落とす。
 * 記録に載せるのは失敗の1行だけで、成功した応答の中身は読まない。
 */
function outcome(
  response: JsonRpcResponse | null,
): { ok: boolean; detail: string; unsupported?: true } {
  // 通知（応答を返さないもの）。受け取れた時点で成功とみなす。
  if (!response) return { ok: true, detail: "" };
  if (response.error) {
    // 未実装のメソッドへの問い合わせ（`server/discover` など）。ツールの失敗ではないので
    // 印を付け、集計で「注意」の判定から外せるようにする（#438）。
    return response.error.code === RpcError.MethodNotFound
      ? { ok: false, detail: response.error.message, unsupported: true }
      : { ok: false, detail: response.error.message };
  }

  const result = response.result as ToolResult | undefined;
  if (result?.isError) {
    const text = result.content?.find((item) => item.type === "text")?.text;
    return { ok: false, detail: text || "ツールがエラーを返した" };
  }
  return { ok: true, detail: "" };
}

/** ボディを読む。上限を超えたら、そこで読むのをやめて `null` を返す。 */
async function readBody(req: IncomingMessage): Promise<string | null> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
