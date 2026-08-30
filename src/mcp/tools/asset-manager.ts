import type { Tool, ToolResult } from "../types.ts";

const DEFAULT_ASSET_MANAGER_URL = "https://asset.gucchii.com";
const REQUEST_TIMEOUT_MS = 8_000;

const PAYMENT_FIELDS = [
  "gmailMessageId",
  "threadId",
  "date",
  "amount",
  "name",
  "place",
  "paymentMethod",
  "accountHint",
  "rawSubject",
  "rawSender",
  "confidence",
  "sourceMetadata",
] as const;

function result(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    // Asset Managerの status は業務上の結果であり、MCPの通信エラーではない。
    isError: false,
  };
}

function invalid(reason: string): ToolResult {
  return result({ status: "error", reason });
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function buildPayload(args: Record<string, unknown>): Record<string, unknown> | string {
  const gmailMessageId = typeof args["gmailMessageId"] === "string" ? args["gmailMessageId"].trim() : "";
  if (!gmailMessageId) return "gmailMessageId は必須です";

  const confidence = args["confidence"];
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return "confidence は 0 以上 1 以下の数値で必須です";
  }

  if (args["date"] !== undefined && !validDate(args["date"])) {
    return "date は YYYY-MM-DD 形式で指定してください";
  }

  if (args["amount"] !== undefined) {
    const amount = args["amount"];
    if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0) {
      return "amount は正の整数で指定してください";
    }
  }

  if (args["sourceMetadata"] !== undefined && (typeof args["sourceMetadata"] !== "object" || args["sourceMetadata"] === null || Array.isArray(args["sourceMetadata"]))) {
    return "sourceMetadata はオブジェクトで指定してください";
  }

  const payload: Record<string, unknown> = { source: "gmail" };
  for (const field of PAYMENT_FIELDS) {
    if (args[field] !== undefined) payload[field] = args[field];
  }
  return payload;
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export const assetManagerImportPaymentTool: Tool = {
  name: "asset_manager_import_payment",
  description:
    "Gmailから抽出した請求情報をAsset Managerへ取り込む。Zaim APIは直接呼ばず、Asset Managerが" +
    "重複判定・信頼度判定・反映待ち登録を行う。Gmailの請求メール1件を取り込むときだけ呼び、" +
    "gmailMessageId は必ず元メールの messageId を渡す。confidence も必ず指定し、曖昧な抽出結果は低くする。" +
    "status（imported / pendingReview / duplicate / ignored / error）、receiptId、zaimMoneyId、reasonを含む" +
    "Asset Managerの結果をそのまま返す。同じgmailMessageIdを再送してもduplicateになる。",
  inputSchema: {
    type: "object",
    properties: {
      gmailMessageId: { type: "string", description: "Gmailの元メールのmessageId。再送・重複防止に使う。" },
      threadId: { type: "string" },
      date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      amount: { type: "integer", minimum: 1 },
      name: { type: "string" },
      place: { type: "string" },
      paymentMethod: { type: "string" },
      accountHint: { type: "string" },
      rawSubject: { type: "string" },
      rawSender: { type: "string" },
      confidence: { type: "number", minimum: 0, maximum: 1, description: "抽出結果の確信度。必須。" },
      sourceMetadata: { type: "object" },
    },
    required: ["gmailMessageId", "confidence"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const payload = buildPayload(args);
    if (typeof payload === "string") return invalid(payload);

    const secret = process.env["AIDE_ASSET_MANAGER_ZAIM_SYNC_SECRET"];
    if (!secret) return invalid("未設定（Asset Manager連携用の認証情報がありません）");

    const baseUrl = process.env["AIDE_ASSET_MANAGER_URL"] || DEFAULT_ASSET_MANAGER_URL;
    const endpoint = `${baseUrl.replace(/\/$/, "")}/api/receipts/import`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      return result(await responseBody(response));
    } catch (cause) {
      const reason = cause instanceof Error && cause.name === "AbortError" ? "Asset Managerへの接続がタイムアウトしました" : "Asset Managerへの接続に失敗しました";
      return invalid(reason);
    } finally {
      clearTimeout(timeout);
    }
  },
};
