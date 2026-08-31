// MCP (Model Context Protocol) の最小型定義。
// 公式SDKを使わず素のNodeで実装しているため、必要な範囲だけ自前で持つ。

/** Claudeアプリが要求してくるバージョンを含む、対応可能なプロトコル一覧（新しい順）。 */
export const SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const DEFAULT_PROTOCOL = SUPPORTED_PROTOCOLS[0];

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  /** 通知の場合は undefined。応答を返してはいけない。 */
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * サーバーが名乗るアイコン（仕様 2025-11-25 の `Icon`）。
 * `initialize` の `serverInfo.icons` に載せると、対応するクライアントがUIに出す。
 */
export interface McpIcon {
  /** 画像のURL。HTTPS か data: に限る（クライアントは他のスキームを拒否してよい）。 */
  src: string;
  mimeType: string;
  /** `"192x192"` の形。可変サイズ（SVG等）なら `["any"]`。 */
  sizes: string[];
}

/** ツールが返すコンテンツ。今はテキストのみ扱う。 */
export interface ToolContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  /** Claudeがツール選択に使う。「何をするか」だけでなく「いつ呼ぶか」を書く。 */
  description: string;
  /** `tools/list` で返すだけの宣言。呼び出し元クライアント向けの案内であり、`type`・`maxLength`・
   * `required` 等はこのサーバー自身では検証しない。実行時の妥当性チェックは各ツールの
   * handler（`buildPayload` 等）に別途書く必要がある。 */
  inputSchema: Record<string, unknown>;
}

export interface Tool extends ToolDefinition {
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult> | ToolResult;
}

export interface ToolContext {
  sessionId: string | null;
}

/** JSON-RPC の標準エラーコード。 */
export const RpcError = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;
