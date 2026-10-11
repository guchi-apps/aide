import { readAssetManagerConfig } from "../../core/connectors/asset-manager/index.ts";
import type { Tool, ToolResult } from "../types.ts";

const REQUEST_TIMEOUT_MS = 8_000;

const PAYMENT_FIELDS = [
  "gmailMessageId",
  "threadId",
  "date",
  "amount",
  "name",
  "place",
  "usage",
  "paymentMethod",
  "accountHint",
  "rawSubject",
  "rawSender",
  "confidence",
  "sourceMetadata",
  "amountApproximate",
  "amountNote",
  "originalAmount",
  "originalCurrency",
] as const;

/** 金額が不確かな理由の上限。Asset Manager の列（VarChar(191)）に収まる長さで、向こうの検証と同じ値（#341）。 */
const MAX_AMOUNT_NOTE_LENGTH = 191;
const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SUBSCRIPTION_NAME_LENGTH = 100;
const MAX_PAYMENT_METHOD_NAME_LENGTH = 50;
const MAX_LABEL_NAME_LENGTH = 30;

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

/**
 * Asset Manager が2xx以外を返したときの結果。
 *
 * 業務上の `duplicate` / `pendingReview` は2xxで返ってくるため、2xx以外はシークレットの不一致（401）や
 * Asset Manager 側の障害（Apacheが返す5xxのHTML）など、連携そのものの失敗にあたる。
 * **ここだけ `isError: true` にする。** MCPアクセスの記録（`transport.ts` の `outcome()`）は
 * `isError` しか見ないため、`false` のままだと失敗が続いても 動作状況（ops-dashboard）から気づけない（#308）。
 * 本文が JSON のオブジェクトなら項目を残し、`status` だけを `error` にそろえる。
 * JSON でない本文（5xxのHTMLなど）は長く、読んでも役に立たないので載せない。
 */
function httpFailure(status: number, body: unknown): ToolResult {
  const detail = body !== null && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const reason = typeof detail["reason"] === "string" && detail["reason"] ? detail["reason"] : `Asset ManagerがHTTP ${status}を返しました`;
  return {
    content: [{ type: "text", text: JSON.stringify({ ...detail, status: "error", reason, httpStatus: status }, null, 2) }],
    isError: true,
  };
}

/**
 * 購入日時として受け付ける形。`YYYY-MM-DD` と `YYYY-MM-DDTHH:mm[:ss]`（末尾に `Z` / `±HH:MM` を付けてもよい）。
 * Asset Manager の `parsePurchasedAt`（`lib/receipt-service.ts`）と同じ書式に揃えてある（#236）。
 * タイムゾーンを省いた場合はAsset Manager側がJSTとして解釈する。
 */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})?)?$/;

function validDate(value: unknown): value is string {
  return typeof value === "string" && DATE_PATTERN.test(value);
}

function validDayKey(value: unknown): value is string {
  if (typeof value !== "string" || !DAY_KEY_PATTERN.test(value)) return false;
  const [year, month, date] = value.split("-").map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(year, month - 1, date));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === date;
}

function buildPricePayload(args: Record<string, unknown>, memoField = "memo"): Record<string, unknown> | string {
  const amount = args["amount"];
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
    return "amount は0以上の数値で指定してください";
  }

  const currency = args["currency"];
  if (currency !== "JPY" && currency !== "USD") return "currency は JPY または USD で指定してください";

  const billingCycle = args["billingCycle"];
  if (billingCycle !== "MONTHLY" && billingCycle !== "YEARLY") {
    return "billingCycle は MONTHLY または YEARLY で指定してください";
  }

  const billingInterval = args["billingInterval"];
  if (typeof billingInterval !== "number" || !Number.isInteger(billingInterval) || billingInterval < 1 || billingInterval > 36) {
    return "billingInterval は1〜36の整数で指定してください";
  }

  const billingDay = args["billingDay"];
  if (typeof billingDay !== "number" || !Number.isInteger(billingDay) || billingDay < 1 || billingDay > 31) {
    return "billingDay は1〜31の整数で指定してください";
  }

  const billingMonth = args["billingMonth"];
  if (billingCycle === "YEARLY" && (typeof billingMonth !== "number" || !Number.isInteger(billingMonth) || billingMonth < 1 || billingMonth > 12)) {
    return "YEARLY の billingMonth は1〜12の整数で指定してください";
  }
  if (billingCycle === "MONTHLY" && billingMonth !== undefined && billingMonth !== null) {
    return "MONTHLY では billingMonth を指定しないでください";
  }

  const effectiveFrom = args["effectiveFrom"];
  if (!validDayKey(effectiveFrom)) return "effectiveFrom は正しい YYYY-MM-DD 形式で指定してください";

  const memo = args[memoField];
  if (memo !== undefined && memo !== null && typeof memo !== "string") return "memo は文字列で指定してください";

  return {
    amount,
    currency,
    billingCycle,
    billingInterval,
    billingDay,
    billingMonth: billingCycle === "YEARLY" ? billingMonth : null,
    effectiveFrom,
    ...(typeof memo === "string" ? { memo: memo.trim() || null } : {}),
  };
}

function buildCreateSubscriptionPayload(args: Record<string, unknown>): Record<string, unknown> | string {
  const name = typeof args["name"] === "string" ? args["name"].trim() : "";
  if (!name) return "name は必須です";
  if (name.length > MAX_SUBSCRIPTION_NAME_LENGTH) return `name は${MAX_SUBSCRIPTION_NAME_LENGTH}文字以内で指定してください`;

  const paymentMethodName = typeof args["paymentMethodName"] === "string" ? args["paymentMethodName"].trim() : "";
  if (!paymentMethodName) return "paymentMethodName は必須です";
  if (paymentMethodName.length > MAX_PAYMENT_METHOD_NAME_LENGTH) {
    return `paymentMethodName は${MAX_PAYMENT_METHOD_NAME_LENGTH}文字以内で指定してください`;
  }

  const startDate = args["startDate"];
  if (!validDayKey(startDate)) return "startDate は正しい YYYY-MM-DD 形式で指定してください";

  const endDate = args["endDate"];
  if (endDate !== undefined && endDate !== null && endDate !== "") {
    if (!validDayKey(endDate)) return "endDate は正しい YYYY-MM-DD 形式で指定してください";
    if (endDate < startDate) return "endDate は startDate 以後の日付で指定してください";
  }

  const autoRenew = args["autoRenew"];
  if (autoRenew !== undefined && typeof autoRenew !== "boolean") return "autoRenew は true / false で指定してください";

  const memo = args["subscriptionMemo"];
  if (memo !== undefined && memo !== null && typeof memo !== "string") return "memo は文字列で指定してください";

  const rawLabels = args["labels"];
  if (rawLabels !== undefined && !Array.isArray(rawLabels)) return "labels は文字列の配列で指定してください";
  const labels: string[] = [];
  for (const label of rawLabels ?? []) {
    if (typeof label !== "string") return "labels は文字列の配列で指定してください";
    const normalized = label.trim();
    if (!normalized) continue;
    if (normalized.length > MAX_LABEL_NAME_LENGTH) return `labels の各項目は${MAX_LABEL_NAME_LENGTH}文字以内で指定してください`;
    labels.push(normalized);
  }

  const price = buildPricePayload(args, "priceMemo");
  if (typeof price === "string") return price;

  return {
    subscription: {
      name,
      paymentMethodName,
      startDate,
      endDate: endDate || null,
      autoRenew: autoRenew ?? true,
      ...(typeof memo === "string" ? { memo: memo.trim() || null } : {}),
      labels,
    },
    price,
  };
}

function buildAddSubscriptionPricePayload(args: Record<string, unknown>): Record<string, unknown> | string {
  const subscriptionId = args["subscriptionId"];
  if (typeof subscriptionId !== "number" || !Number.isInteger(subscriptionId) || subscriptionId <= 0) {
    return "subscriptionId は正の整数で指定してください";
  }

  const price = buildPricePayload(args);
  if (typeof price === "string") return price;
  return { subscriptionId, price };
}

function buildPayload(args: Record<string, unknown>): Record<string, unknown> | string {
  const gmailMessageId = typeof args["gmailMessageId"] === "string" ? args["gmailMessageId"].trim() : "";
  if (!gmailMessageId) return "gmailMessageId は必須です";

  const confidence = args["confidence"];
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return "confidence は 0 以上 1 以下の数値で必須です";
  }

  if (args["date"] !== undefined && !validDate(args["date"])) {
    return "date は YYYY-MM-DD または YYYY-MM-DDTHH:mm 形式で指定してください";
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

  if (args["usage"] !== undefined) {
    const usage = args["usage"];
    if (typeof usage !== "string" || usage.length > 32) {
      return "usage は32文字以内の文字列で指定してください";
    }
  }

  // 金額の精度（外貨・概算）。判定基準はAsset Managerの `validatePaymentImportInput` に揃えてある（#341）。
  if (args["amountApproximate"] !== undefined && typeof args["amountApproximate"] !== "boolean") {
    return "amountApproximate は true / false で指定してください";
  }

  if (args["amountNote"] !== undefined) {
    const amountNote = args["amountNote"];
    if (typeof amountNote !== "string") return "amountNote は文字列で指定してください";
    if (amountNote.trim().length > MAX_AMOUNT_NOTE_LENGTH) {
      return `amountNote は ${MAX_AMOUNT_NOTE_LENGTH}文字以内で指定してください`;
    }
  }

  if (args["originalAmount"] !== undefined) {
    const originalAmount = args["originalAmount"];
    if (typeof originalAmount !== "number" || !Number.isFinite(originalAmount) || originalAmount <= 0) {
      return "originalAmount は正の数で指定してください";
    }
  }

  if (args["originalCurrency"] !== undefined) {
    const originalCurrency = args["originalCurrency"];
    if (typeof originalCurrency !== "string" || !/^[A-Za-z]{3}$/.test(originalCurrency.trim())) {
      return "originalCurrency は USD のような3文字の通貨コードで指定してください";
    }
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

/**
 * Asset Manager のサーバー間APIを呼ぶ共通の経路（取り込みも読み取りも同じ）。
 *
 * 認証は `AIDE_ASSET_MANAGER_ZAIM_SYNC_SECRET` のBearer、宛先は `AIDE_ASSET_MANAGER_URL`。
 * 向こうでは `POST /api/receipts/import`・`GET /api/subscriptions` とも同じ `ZAIM_SYNC_SECRET` で照合される。
 * シークレットはMCPの入力・出力・ログへ出さない。未設定・タイムアウト・接続失敗は状態として返し（`isError` にしない）、
 * 2xx以外だけ `httpFailure` で `isError: true` にする。
 */
async function callAssetManager(path: string, request: { method: "GET" | "POST" | "PATCH"; body?: unknown }): Promise<ToolResult> {
  const config = await readAssetManagerConfig();
  if (!config) return invalid("未設定（Asset Manager連携用の認証情報がありません）");

  const endpoint = `${config.baseUrl}${path}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${config.secret}`, Accept: "application/json" };
  if (request.body !== undefined) headers["Content-Type"] = "application/json";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: request.method,
      headers,
      ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
      signal: controller.signal,
    });
    const responseJson = await responseBody(response);
    return response.ok ? result(responseJson) : httpFailure(response.status, responseJson);
  } catch (cause) {
    const reason = cause instanceof Error && cause.name === "AbortError" ? "Asset Managerへの接続がタイムアウトしました" : "Asset Managerへの接続に失敗しました";
    return invalid(reason);
  } finally {
    clearTimeout(timeout);
  }
}

export const assetManagerImportPaymentTool: Tool = {
  name: "asset_manager_import_payment",
  description:
    "Gmailから抽出した請求情報をAsset Managerへ取り込む。Zaim APIは直接呼ばず、Asset Managerが" +
    "重複判定・信頼度判定・反映待ち登録を行う。Gmailの請求メール1件を取り込むときだけ呼び、" +
    "gmailMessageId は必ず元メールの messageId を渡す。confidence も必ず指定し、曖昧な抽出結果は低くする。" +
    "status（imported / pendingReview / duplicate / ignored / error）、receiptId、zaimMoneyId、reasonを含む" +
    "Asset Managerの結果をそのまま返す。同じgmailMessageIdを再送してもduplicateになる。" +
    "Asset Managerが2xx以外を返したときは、isError付きで status: error・reason・httpStatus を返す。" +
    "date は本文に購入時刻が印字されているときだけ時刻まで付け、読み取れないときは日付だけを送る。" +
    "ドル建てなど外貨建ての請求メールでは、originalAmount（外貨の元の金額）と originalCurrency（通貨コード）を必ず付け、" +
    "amount には円へ換算して整数へ丸めた金額を入れる（amount は整数のみ。換算レートと丸めは amountNote に書く）。" +
    "外貨建ての明細は概算として扱われ、Zaimへ自動登録されない。",
  inputSchema: {
    type: "object",
    properties: {
      gmailMessageId: { type: "string", description: "Gmailの元メールのmessageId。再送・重複防止に使う。" },
      threadId: { type: "string" },
      date: {
        type: "string",
        pattern: DATE_PATTERN.source,
        description:
          "購入日時。JSTで `YYYY-MM-DD`、または時刻まで分かる場合は `YYYY-MM-DDTHH:mm`（秒・末尾の `Z` / `+09:00` も可）。" +
          "時刻を付けるのは、メール本文に購入時刻・利用時刻が印字されていて読み取れるときだけにする。" +
          "読み取れない・自信が無いときは日付だけを送る（推測した時刻を送らない）。" +
          "メールの受信日時（internalDate・Dateヘッダ）を購入時刻として使ってはいけない" +
          "（請求メールは購入から数時間〜数日遅れて届くため）。",
      },
      amount: {
        type: "integer",
        minimum: 1,
        description:
          "円建ての金額（整数のみ。小数は受け付けない）。外貨建ての請求メールでは円へ換算して整数へ丸めた金額を入れ、" +
          "元の金額は originalAmount / originalCurrency に渡し、換算レートと丸めは amountNote に書く。",
      },
      amountApproximate: {
        type: "boolean",
        description:
          "金額が正確でない可能性があるときに true。為替換算した・請求額が確定前の見込み、など。" +
          "originalCurrency が JPY 以外なら省いてもAsset Manager側で概算として扱う。概算の明細はZaimへ自動登録されず、Asset Managerの突合せタブで確定する。",
      },
      amountNote: {
        type: "string",
        maxLength: MAX_AMOUNT_NOTE_LENGTH,
        description: "金額が不確かな理由。例: `USD 9.99 を 1ドル=150.2円で換算`。191文字以内。",
      },
      originalAmount: {
        type: "number",
        exclusiveMinimum: 0,
        description: "外貨建ての請求メールで、外貨の元の金額（例: 9.99）。外貨建てなら必ず指定する。",
      },
      originalCurrency: {
        type: "string",
        pattern: "^[A-Za-z]{3}$",
        description: "originalAmount の通貨。ISO 4217 の3文字コード（例: USD）。外貨建てなら必ず指定する。",
      },
      name: { type: "string" },
      place: { type: "string" },
      usage: {
        type: "string",
        maxLength: 32,
        description:
          "電気・ガスなど使用量が書かれた請求メールでのみ指定する（例: 258kWh、12m3）。" +
          "本文の表記のまま渡してよく、単位表記（kWh・m3・m³・㎥ 等）の正規化はAsset Manager側が行う。" +
          "name には使用量を含めない（分類履歴のキーに影響するため）。本文から読み取れない・自信が無い場合は指定せず省略する（推測値を送らない）。",
      },
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

    return callAssetManager("/api/receipts/import", { method: "POST", body: payload });
  },
};

/**
 * サブスクの一覧の読み取り（#345。Asset Manager 側は asset-manager#491 の `GET /api/subscriptions`）。
 *
 * 応答は既定で契約ごとの履歴だけを省き（#489。`includeHistory: true` で全部返す）、それ以外は加工せず返す。
 * 月額換算・次回請求日・契約状況・円換算は向こうが計算済みで、
 * こちらで再計算すればズレる（`aide_fixed_costs` と同じ「計算はしない」方針）。
 * `aide_fixed_costs` も同じAPIを読み、月額・支払方法別・31日以内の支払予定へ畳んで返す（#347）。
 */
/**
 * 契約ごとの履歴（`priceHistory`・`paymentMethodHistory`）を省く（#489）。
 *
 * 履歴は契約ごとに付き、支払方法の履歴は現在値（`paymentMethod`・`zaimLink`…）の重複がほとんどで、
 * 22契約で応答が約40KBになっていた。「いくら払っているか・次にいつ請求されるか」には要らない。
 * **ただし将来日付の料金改定は「次にいくら請求されるか」に効く**ため、`scheduledPriceChanges` へ残す。
 * 計算はせず、Asset Manager が付けた `isCurrent` を基準に抜き出すだけ。
 */
export function omitSubscriptionHistory(payload: unknown): unknown {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const body = payload as Record<string, unknown>;
  if (!Array.isArray(body["subscriptions"])) return payload;

  const subscriptions = body["subscriptions"].map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const { priceHistory, paymentMethodHistory: _omitted, ...rest } = entry as Record<string, unknown>;
    // Asset Manager は履歴を古い順に並べ、今適用中の行に `isCurrent` を付けている。
    // 日付をこちらで比べると向こうの日境界とズレうるため、「isCurrent の行より後ろ」を未来の改定とする。
    // 適用中の行が無い（解約済みなど）ときは何も残さない。
    const current = Array.isArray(priceHistory)
      ? priceHistory.findIndex((price) => (price as { isCurrent?: unknown } | null)?.isCurrent === true)
      : -1;
    const scheduled = current >= 0 ? (priceHistory as unknown[]).slice(current + 1) : [];
    return scheduled.length > 0 ? { ...rest, scheduledPriceChanges: scheduled } : rest;
  });
  return { ...body, subscriptions };
}

/** 全角半角・大文字小文字・前後の空白の違いを無視して比べるための正規化。 */
function normalizeName(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

function isSimilarName(existing: string, requested: string): boolean {
  const a = normalizeName(existing);
  const b = normalizeName(requested);
  return a !== "" && b !== "" && (a === b || a.includes(b) || b.includes(a));
}

/** 契約名の部分一致で絞る。合計（summary）は全体のままで、`nameFilter` に件数を添える。 */
function filterSubscriptionsByName(payload: unknown, query: string): unknown {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const body = payload as Record<string, unknown>;
  if (!Array.isArray(body["subscriptions"])) return payload;
  const needle = normalizeName(query);
  const matched = body["subscriptions"].filter((entry) => normalizeName(String((entry as { name?: unknown } | null)?.name ?? "")).includes(needle));
  return { ...body, subscriptions: matched, nameFilter: { query, matchCount: matched.length } };
}

export const assetManagerSubscriptionsTool: Tool = {
  name: "asset_manager_subscriptions",
  description:
    "Asset Manager（サブスク管理の移管先）が持つサブスクの一覧を返す。合計（月額・年額・件数）、次に請求されるもの、" +
    "契約ごとの明細（1回あたりの請求額・月あたりの金額・請求サイクル・次回請求日・支払方法・ラベル・契約期間・メモ）を含む。" +
    "「いま何にいくら払っているか」「次に何が更新されるか・いつ請求されるか」「解約予定のサブスクはどれか」を尋ねられたときに呼ぶ。" +
    "読み取り専用。既定では解約済みを含めず、過去の契約まで要るときだけ includeEnded: true を指定する。" +
    "金額の読み方: 「いくら払っているか」には monthlyAmountJpy（月あたりの円換算）を使い、「次にいくら請求されるか」には amount（1回あたり）を使う" +
    "（3ヶ月ごと・毎年払いのサブスクがあるため両者は別物）。" +
    "status が SCHEDULED_TO_END（解約予定）のものはまだ払っているので summary の合計に含まれる。「解約したもの」として扱うのは ENDED だけ。" +
    "usdJpyRate が null（為替レートを取れなかった）のとき、ドル建ては monthlyAmountJpy が null になり合計から外れる。" +
    "合計を答えるときは summary.excludedFromTotal が空かを確認し、空でなければ外れたサブスク名を添える。" +
    "summary.monthlyTotalJpy などはサブスク区分だけの集計で、保険・税金・分割払いを含む固定費全体は summary.fixedCost* と byCategory にある。" +
    "aide_fixed_costs は同じデータを、固定費全体の月額合計（通貨別）・支払方法別の合計・31日以内の支払予定へ畳んだ要約で、" +
    "「毎月の固定費はいくらか」「どのカードから毎月いくら落ちるか」だけを知りたいときはそちらが軽い。契約ごとの詳細・料金履歴が要るときはこのツールを呼ぶ。" +
    "既定では応答を小さくするため、契約ごとの料金履歴（priceHistory）と支払方法の履歴（paymentMethodHistory）は省き、" +
    "今日より先に適用される料金改定だけを scheduledPriceChanges で返す（無ければ項目自体が無い）。" +
    "過去の料金改定・支払方法の変更履歴まで尋ねられたときだけ includeHistory: true を指定する。",
  inputSchema: {
    type: "object",
    properties: {
      includeEnded: {
        type: "boolean",
        description: "true で解約済み（ENDED）も含める。省略時は含めない。過去の契約まで尋ねられたときだけ指定する。",
      },
      name: {
        type: "string",
        description: "契約名の部分一致（全角半角・大文字小文字を区別しない）で絞り込む。更新前に対象のIDを確かめるときに使う。候補が複数なら利用者に選んでもらう。",
      },
      includeHistory: {
        type: "boolean",
        description:
          "true で契約ごとの料金履歴（priceHistory）と支払方法の履歴（paymentMethodHistory）も返す。省略時は返さない。過去の料金改定・支払方法の変更まで尋ねられたときだけ指定する。",
      },
    },
    additionalProperties: false,
  },
  handler: async (args) => {
    const includeEnded = args["includeEnded"];
    if (includeEnded !== undefined && typeof includeEnded !== "boolean") {
      return invalid("includeEnded は true / false で指定してください");
    }

    const includeHistory = args["includeHistory"];
    if (includeHistory !== undefined && typeof includeHistory !== "boolean") {
      return invalid("includeHistory は true / false で指定してください");
    }

    const nameFilter = args["name"];
    if (nameFilter !== undefined && (typeof nameFilter !== "string" || !nameFilter.trim())) {
      return invalid("name は空でない文字列で指定してください");
    }

    const response = await callAssetManager(
      includeEnded ? "/api/subscriptions?includeEnded=1" : "/api/subscriptions",
      { method: "GET" },
    );
    if ((includeHistory && nameFilter === undefined) || response.isError) return response;
    // 未設定・タイムアウト（`status: "error"`）や JSON でない本文は、そのまま返す。
    try {
      const text = response.content[0]?.text ?? "";
      let body: unknown = JSON.parse(text);
      if (!includeHistory) body = omitSubscriptionHistory(body);
      if (typeof nameFilter === "string") body = filterSubscriptionsByName(body, nameFilter);
      return result(body);
    } catch {
      return response;
    }
  },
};

/** サブスクと初回料金を新規登録する（#346。Asset Manager 側は asset-manager#502）。 */
export const assetManagerCreateSubscriptionTool: Tool = {
  name: "asset_manager_create_subscription",
  description:
    "Asset Managerへサブスクと最初の料金を新規登録する書き込みツール。既存のサブスク・料金は変更も削除もできない。" +
    "登録前に asset_manager_subscriptions の paymentMethod で支払い方法の名前を確認し、paymentMethodName にはその名前を正確に指定する。" +
    "料金は「1回あたりの請求額」を amount に入れ、プラン変更・値上げはこのツールで作り直さず asset_manager_add_subscription_price を使う。" +
    "登録前に同名・類似名の既存契約（解約済みを含む）を自動で確認し、候補があれば登録せず status: duplicateCandidates と候補を返す。" +
    "既存契約の名前・メモ・終了日・解約情報の更新はこのツールではなく asset_manager_update_subscription / asset_manager_record_subscription_cancellation を使う。" +
    "実行すると契約と初回料金が作成されるため、内容を利用者に確認してから呼ぶ。",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", maxLength: MAX_SUBSCRIPTION_NAME_LENGTH, description: "サブスク名。" },
      paymentMethodName: { type: "string", maxLength: MAX_PAYMENT_METHOD_NAME_LENGTH, description: "登録済みの支払い方法名。" },
      startDate: { type: "string", pattern: DAY_KEY_PATTERN.source, description: "契約開始日（YYYY-MM-DD）。" },
      endDate: { type: ["string", "null"], pattern: DAY_KEY_PATTERN.source, description: "契約終了日。未定なら省略または null。" },
      autoRenew: { type: "boolean", description: "自動更新するか。省略時は true。" },
      subscriptionMemo: { type: ["string", "null"], description: "契約のメモ。" },
      labels: { type: "array", items: { type: "string", maxLength: MAX_LABEL_NAME_LENGTH }, description: "ラベル名。未登録の名前はAsset Manager側で作成する。" },
      amount: { type: "number", minimum: 0, description: "1回あたりの請求額。" },
      currency: { type: "string", enum: ["JPY", "USD"] },
      billingCycle: { type: "string", enum: ["MONTHLY", "YEARLY"] },
      billingInterval: { type: "integer", minimum: 1, maximum: 36, description: "何か月・何年ごとか。" },
      billingDay: { type: "integer", minimum: 1, maximum: 31, description: "支払日。" },
      billingMonth: { type: "integer", minimum: 1, maximum: 12, description: "毎年払いの支払い月。MONTHLYでは指定しない。" },
      effectiveFrom: { type: "string", pattern: DAY_KEY_PATTERN.source, description: "初回料金の適用開始日（YYYY-MM-DD）。" },
      priceMemo: { type: ["string", "null"], description: "初回料金のメモ。" },
      allowDuplicate: {
        type: "boolean",
        description:
          "同名・類似名の既存契約があっても新規登録するときだけ true。省略時は重複候補があると登録せず候補を返す（既存契約の編集は asset_manager_update_subscription を使う）。",
      },
    },
    required: ["name", "paymentMethodName", "startDate", "amount", "currency", "billingCycle", "billingInterval", "billingDay", "effectiveFrom"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const payload = buildCreateSubscriptionPayload(args);
    if (typeof payload === "string") return invalid(payload);

    if (args["allowDuplicate"] !== undefined && typeof args["allowDuplicate"] !== "boolean") {
      return invalid("allowDuplicate は true / false で指定してください");
    }
    if (args["allowDuplicate"] !== true) {
      const listed = await fetchSubscriptionList();
      if (!listed.ok) return listed.result;
      const name = (payload["subscription"] as { name: string }).name;
      const candidates = listed.subscriptions.filter((entry) => isSimilarName(String(entry["name"] ?? ""), name));
      if (candidates.length > 0) {
        return result({
          status: "duplicateCandidates",
          applied: false,
          reason: "同名・類似名の既存契約があるため登録していません。同じ契約なら asset_manager_update_subscription で更新し、別契約なら allowDuplicate: true で再実行してください",
          candidates: candidates.map(snapshotOf),
        });
      }
    }
    return callAssetManager("/api/subscriptions", { method: "POST", body: payload });
  },
};

/** 既存サブスクへ料金改定の履歴を追加する（#346。Asset Manager 側は asset-manager#502）。 */
export const assetManagerAddSubscriptionPriceTool: Tool = {
  name: "asset_manager_add_subscription_price",
  description:
    "Asset Managerの既存サブスクへ、プラン変更・値上げ・値下げ後の料金を履歴として追加する書き込みツール。" +
    "既存料金を上書きしない。対象は asset_manager_subscriptions の id で指定し、適用開始日 effectiveFrom を必ず指定する。" +
    "同じ適用開始日の料金は追加できない。既存の適用開始日は asset_manager_subscriptions を includeHistory: true で呼んで priceHistory の effectiveFrom を確かめる。" +
    "内容を利用者に確認してから呼ぶ。",
  inputSchema: {
    type: "object",
    properties: {
      subscriptionId: { type: "integer", minimum: 1, description: "asset_manager_subscriptions が返したサブスク ID。" },
      amount: { type: "number", minimum: 0, description: "1回あたりの改定後の請求額。" },
      currency: { type: "string", enum: ["JPY", "USD"] },
      billingCycle: { type: "string", enum: ["MONTHLY", "YEARLY"] },
      billingInterval: { type: "integer", minimum: 1, maximum: 36 },
      billingDay: { type: "integer", minimum: 1, maximum: 31 },
      billingMonth: { type: "integer", minimum: 1, maximum: 12, description: "毎年払いの支払い月。MONTHLYでは指定しない。" },
      effectiveFrom: { type: "string", pattern: DAY_KEY_PATTERN.source, description: "改定料金の適用開始日（YYYY-MM-DD）。" },
      memo: { type: ["string", "null"], description: "料金改定のメモ。" },
    },
    required: ["subscriptionId", "amount", "currency", "billingCycle", "billingInterval", "billingDay", "effectiveFrom"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const payload = buildAddSubscriptionPricePayload(args);
    if (typeof payload === "string") return invalid(payload);
    return callAssetManager(`/api/subscriptions/${payload["subscriptionId"]}/prices`, { method: "POST", body: { price: payload["price"] } });
  },
};

/**
 * 契約の編集・解約情報の更新（#642。Asset Manager 側は `PATCH /api/subscriptions/:id`）。
 *
 * 台帳（Asset Manager）の記録を直すだけで、事業者サイトでの実際の解約・購入は行わない。削除は持たない。
 * 変更は「指定した項目だけ」。送る前に一覧を引き直して対象を確かめ（ID・名前の一致）、
 * 変更前の値と `updatedAt`（競合検知）を取り、変更後は再取得して返す。
 */

/** 応答に載せる契約の項目。変更前後の比較に使うものだけに絞る。 */
const SNAPSHOT_FIELDS = [
  "id",
  "name",
  "category",
  "status",
  "paymentMethod",
  "startDate",
  "endDate",
  "autoRenew",
  "cancelPlanned",
  "memo",
  "labels",
  "nextBillingDay",
  "updatedAt",
] as const;

const SUBSCRIPTION_CATEGORIES = ["SUBSCRIPTION", "INSURANCE", "TAX", "INSTALLMENT", "OTHER_FIXED_COST"] as const;
const MAX_MEMO_LENGTH = 1000;

type SubscriptionRecord = Record<string, unknown>;

function snapshotOf(entry: SubscriptionRecord): SubscriptionRecord {
  const picked: SubscriptionRecord = {};
  for (const field of SNAPSHOT_FIELDS) if (field in entry) picked[field] = entry[field];
  return picked;
}

function parseToolBody(toolResult: ToolResult): unknown {
  try {
    return JSON.parse(toolResult.content[0]?.text ?? "");
  } catch {
    return null;
  }
}

/** 全契約（解約済みを含む）を取得する。失敗時は返すべき ToolResult を持つ。 */
async function fetchSubscriptionList(): Promise<
  { ok: true; subscriptions: SubscriptionRecord[] } | { ok: false; result: ToolResult }
> {
  const response = await callAssetManager("/api/subscriptions?includeEnded=1", { method: "GET" });
  const body = parseToolBody(response) as { status?: unknown; subscriptions?: unknown } | null;
  if (response.isError || !body || body.status === "error" || !Array.isArray(body.subscriptions)) {
    return { ok: false, result: response.isError || body?.status === "error" ? response : invalid("Asset Managerの契約一覧を読み取れませんでした") };
  }
  return { ok: true, subscriptions: body.subscriptions as SubscriptionRecord[] };
}

function todayJst(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
}

function memoOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sameLabels(a: unknown, b: string[]): boolean {
  const left = Array.isArray(a) ? a.map(String).sort() : [];
  return JSON.stringify(left) === JSON.stringify([...b].sort());
}

interface SubscriptionPatch {
  name?: string;
  category?: string;
  paymentMethodName?: string;
  paymentMethodEffectiveFrom?: string;
  startDate?: string;
  endDate?: string | null;
  autoRenew?: boolean;
  cancelPlanned?: boolean;
  memo?: string | null;
  labels?: string[];
}

function parseSubscriptionPatch(args: Record<string, unknown>): SubscriptionPatch | string {
  const patch: SubscriptionPatch = {};

  if (args["name"] !== undefined) {
    const name = typeof args["name"] === "string" ? args["name"].trim() : "";
    if (!name) return "name は空でない文字列で指定してください";
    if (name.length > MAX_SUBSCRIPTION_NAME_LENGTH) return `name は${MAX_SUBSCRIPTION_NAME_LENGTH}文字以内で指定してください`;
    patch.name = name;
  }
  if (args["category"] !== undefined) {
    if (!(SUBSCRIPTION_CATEGORIES as readonly unknown[]).includes(args["category"])) {
      return `category は ${SUBSCRIPTION_CATEGORIES.join(" / ")} のいずれかで指定してください`;
    }
    patch.category = args["category"] as string;
  }
  if (args["paymentMethodName"] !== undefined) {
    const method = typeof args["paymentMethodName"] === "string" ? args["paymentMethodName"].trim() : "";
    if (!method) return "paymentMethodName は空でない文字列で指定してください";
    if (method.length > MAX_PAYMENT_METHOD_NAME_LENGTH) return `paymentMethodName は${MAX_PAYMENT_METHOD_NAME_LENGTH}文字以内で指定してください`;
    if (!validDayKey(args["paymentMethodEffectiveFrom"])) {
      return "支払方法を変えるときは paymentMethodEffectiveFrom（適用開始日。YYYY-MM-DD）も指定してください（支払方法の履歴に残すため）";
    }
    patch.paymentMethodName = method;
    patch.paymentMethodEffectiveFrom = args["paymentMethodEffectiveFrom"];
  } else if (args["paymentMethodEffectiveFrom"] !== undefined) {
    return "paymentMethodEffectiveFrom は paymentMethodName と一緒に指定してください";
  }
  if (args["startDate"] !== undefined) {
    if (!validDayKey(args["startDate"])) return "startDate は正しい YYYY-MM-DD 形式で指定してください";
    patch.startDate = args["startDate"];
  }
  if (args["endDate"] !== undefined) {
    if (args["endDate"] !== null && !validDayKey(args["endDate"])) return "endDate は正しい YYYY-MM-DD 形式、または null（終了日を消す）で指定してください";
    patch.endDate = args["endDate"] as string | null;
  }
  for (const field of ["autoRenew", "cancelPlanned"] as const) {
    if (args[field] !== undefined) {
      if (typeof args[field] !== "boolean") return `${field} は true / false で指定してください`;
      patch[field] = args[field] as boolean;
    }
  }
  if (args["memo"] !== undefined) {
    if (args["memo"] !== null && typeof args["memo"] !== "string") return "memo は文字列または null で指定してください";
    if (typeof args["memo"] === "string" && args["memo"].length > MAX_MEMO_LENGTH) return `memo は${MAX_MEMO_LENGTH}文字以内で指定してください`;
    patch.memo = memoOf(args["memo"]);
  }
  if (args["labels"] !== undefined) {
    if (!Array.isArray(args["labels"])) return "labels は文字列の配列で指定してください";
    const labels: string[] = [];
    for (const label of args["labels"]) {
      if (typeof label !== "string") return "labels は文字列の配列で指定してください";
      const normalized = label.trim();
      if (!normalized) continue;
      if (normalized.length > MAX_LABEL_NAME_LENGTH) return `labels の各項目は${MAX_LABEL_NAME_LENGTH}文字以内で指定してください`;
      if (!labels.includes(normalized)) labels.push(normalized);
    }
    patch.labels = labels;
  }
  return patch;
}

function parseTarget(args: Record<string, unknown>): { subscriptionId: number; expectedName: string } | string {
  const subscriptionId = args["subscriptionId"];
  if (typeof subscriptionId !== "number" || !Number.isInteger(subscriptionId) || subscriptionId <= 0) {
    return "subscriptionId は正の整数で指定してください";
  }
  const expectedName = typeof args["expectedName"] === "string" ? args["expectedName"].trim() : "";
  if (!expectedName) return "expectedName は必須です（asset_manager_subscriptions で確認した契約名を指定してください）";
  return { subscriptionId, expectedName };
}

/** 変更後の値が、変更前と同じ項目を除いたものにする（再実行で何も起きない判定にも使う）。 */
function effectivePatch(before: SubscriptionRecord, patch: SubscriptionPatch): SubscriptionPatch {
  const changed: SubscriptionPatch = {};
  if (patch.name !== undefined && patch.name !== before["name"]) changed.name = patch.name;
  if (patch.category !== undefined && patch.category !== before["category"]) changed.category = patch.category;
  if (patch.paymentMethodName !== undefined && patch.paymentMethodName !== before["paymentMethod"]) {
    changed.paymentMethodName = patch.paymentMethodName;
    if (patch.paymentMethodEffectiveFrom !== undefined) changed.paymentMethodEffectiveFrom = patch.paymentMethodEffectiveFrom;
  }
  if (patch.startDate !== undefined && patch.startDate !== before["startDate"]) changed.startDate = patch.startDate;
  if (patch.endDate !== undefined && patch.endDate !== (before["endDate"] ?? null)) changed.endDate = patch.endDate;
  if (patch.autoRenew !== undefined && patch.autoRenew !== before["autoRenew"]) changed.autoRenew = patch.autoRenew;
  if (patch.cancelPlanned !== undefined && patch.cancelPlanned !== before["cancelPlanned"]) changed.cancelPlanned = patch.cancelPlanned;
  if (patch.memo !== undefined && patch.memo !== memoOf(before["memo"])) changed.memo = patch.memo;
  if (patch.labels !== undefined && !sameLabels(before["labels"], patch.labels)) changed.labels = patch.labels;
  return changed;
}

/**
 * 契約を更新する共通の流れ。対象の確認 → 変更前の取得 → 検証 → PATCH → 再取得。
 * どの段階で失敗しても `applied: false` を返し、誤って「更新した」と読めないようにする。
 */
async function updateSubscription(
  target: { subscriptionId: number; expectedName: string },
  buildPatch: (before: SubscriptionRecord) => SubscriptionPatch | string,
): Promise<ToolResult> {
  const listed = await fetchSubscriptionList();
  if (!listed.ok) return withNotApplied(listed.result);

  const before = listed.subscriptions.find((entry) => entry["id"] === target.subscriptionId);
  if (!before) {
    return result({ status: "error", applied: false, reason: `ID ${target.subscriptionId} の契約が見つかりません（他のユーザーの契約も含め、存在しないものは変更できません）` });
  }
  if (normalizeName(String(before["name"] ?? "")) !== normalizeName(target.expectedName)) {
    return result({
      status: "error",
      applied: false,
      reason: `ID ${target.subscriptionId} の契約名は「${String(before["name"])}」で、指定された「${target.expectedName}」と一致しません。対象を取り違えていないか確かめてください`,
      candidate: snapshotOf(before),
    });
  }

  const requested = buildPatch(before);
  if (typeof requested === "string") return result({ status: "error", applied: false, reason: requested });

  const changed = effectivePatch(before, requested);
  const changedFields = Object.keys(changed).filter((field) => field !== "paymentMethodEffectiveFrom");
  if (changedFields.length === 0) {
    return result({ status: "unchanged", applied: false, id: target.subscriptionId, reason: "指定された内容はすでに反映済みのため、変更していません", before: snapshotOf(before), after: snapshotOf(before) });
  }

  const startDate = changed.startDate ?? (before["startDate"] as string | undefined);
  const endDate = changed.endDate !== undefined ? changed.endDate : ((before["endDate"] as string | null | undefined) ?? null);
  if (startDate && endDate && endDate < startDate) {
    return result({ status: "error", applied: false, reason: "endDate は startDate 以後の日付にしてください" });
  }

  const response = await callAssetManager(`/api/subscriptions/${target.subscriptionId}`, {
    method: "PATCH",
    body: {
      expectedName: String(before["name"]),
      ...(typeof before["updatedAt"] === "string" ? { expectedUpdatedAt: before["updatedAt"] } : {}),
      subscription: changed,
    },
  });
  const body = parseToolBody(response) as Record<string, unknown> | null;
  if (response.isError || !body || body["status"] === "error") {
    return withNotApplied(response, response.isError ? "更新に失敗しました" : undefined);
  }

  const reread = await fetchSubscriptionList();
  const after = reread.ok ? reread.subscriptions.find((entry) => entry["id"] === target.subscriptionId) : undefined;
  const warnings: string[] = [];
  if (after && after["status"] === "ENDED") warnings.push("終了日が過ぎているため、この契約は終了（ENDED）として扱われます");
  if (!after) warnings.push("更新後の再取得に失敗しました。asset_manager_subscriptions で反映を確認してください");
  return result({
    status: "updated",
    applied: true,
    id: target.subscriptionId,
    changedFields,
    before: snapshotOf(before),
    after: after ? snapshotOf(after) : null,
    ...(warnings.length > 0 ? { warnings } : {}),
    note: "Asset Managerの台帳を更新しただけで、事業者側の契約は変更していません",
  });
}

/** 失敗結果に「未反映」を明示する。PATCH未対応（404・405）は原因の見当も添える。 */
function withNotApplied(failure: ToolResult, fallbackReason?: string): ToolResult {
  const body = (parseToolBody(failure) ?? {}) as Record<string, unknown>;
  const httpStatus = body["httpStatus"];
  let reason = typeof body["reason"] === "string" ? body["reason"] : fallbackReason ?? "更新に失敗しました";
  if ((httpStatus === 404 || httpStatus === 405) && /^Asset ManagerがHTTP/.test(reason)) {
    reason = `${reason}。Asset Manager側に契約編集API（PATCH /api/subscriptions/:id）が未反映の可能性があります`;
  }
  if (httpStatus === 409) reason = `${reason}（直前に別の更新があった可能性があります。asset_manager_subscriptions で最新の状態を確認してから再実行してください）`;
  return { content: [{ type: "text", text: JSON.stringify({ ...body, status: "error", applied: false, reason: `${reason}。変更は反映されていません` }, null, 2) }], isError: failure.isError };
}

const TARGET_PROPERTIES = {
  subscriptionId: { type: "integer", minimum: 1, description: "asset_manager_subscriptions が返した契約ID。" },
  expectedName: {
    type: "string",
    description: "対象の契約名（asset_manager_subscriptions で確認した名前）。IDの契約名と一致しなければ何も変更しない。",
  },
} as const;

export const assetManagerUpdateSubscriptionTool: Tool = {
  name: "asset_manager_update_subscription",
  description:
    "Asset Managerの既存サブスク（契約）の項目を編集する書き込みツール。**指定した項目だけを変更し、未指定の項目と料金・支払方法の履歴は保持する。**" +
    "編集できるのは名前・区分・支払方法・ラベル・メモ・開始日・終了日・自動更新・解約予定（cancelPlanned）。削除と料金の上書きはできない。" +
    "使い分け: 新しい契約は asset_manager_create_subscription、値上げ・プラン変更は asset_manager_add_subscription_price（履歴を足す）、" +
    "解約の記録は asset_manager_record_subscription_cancellation、それ以外の契約情報の修正はこのツール。" +
    "呼ぶ前に asset_manager_subscriptions（name で絞れる）で対象を確かめ、候補が複数ある・名前が曖昧なときは利用者に選んでもらう。" +
    "subscriptionId と expectedName の両方が一致しないと変更しない。変更内容を利用者に確認してから呼ぶ。" +
    "支払方法を変えるときは適用開始日 paymentMethodEffectiveFrom も渡す（支払方法の履歴に1件追加される）。" +
    "labels は渡した配列で置き換える（全件を渡す）。endDate: null で終了日を消す。memo: null でメモを消す。" +
    "同じ内容での再実行は status: unchanged で何も変えない。結果は status・applied・変更前後（before/after）を返し、" +
    "失敗時は applied: false で未反映を明示する。これは台帳の更新で、事業者サイトでの契約・解約そのものは行わない。",
  inputSchema: {
    type: "object",
    properties: {
      ...TARGET_PROPERTIES,
      name: { type: "string", maxLength: MAX_SUBSCRIPTION_NAME_LENGTH, description: "新しい契約名。" },
      category: { type: "string", enum: [...SUBSCRIPTION_CATEGORIES], description: "区分。" },
      paymentMethodName: { type: "string", maxLength: MAX_PAYMENT_METHOD_NAME_LENGTH, description: "新しい支払方法名（登録済みの名前）。" },
      paymentMethodEffectiveFrom: { type: "string", pattern: DAY_KEY_PATTERN.source, description: "新しい支払方法の適用開始日。paymentMethodName と一緒に指定する。" },
      startDate: { type: "string", pattern: DAY_KEY_PATTERN.source, description: "契約開始日。" },
      endDate: { type: ["string", "null"], pattern: DAY_KEY_PATTERN.source, description: "契約終了日（利用できる最終日）。null で消す。" },
      autoRenew: { type: "boolean", description: "自動更新するか。" },
      cancelPlanned: { type: "boolean", description: "解約予定（検討中を含む）か。" },
      memo: { type: ["string", "null"], maxLength: MAX_MEMO_LENGTH, description: "契約のメモ（全文を置き換える）。既存のメモを残すなら含めて渡す。" },
      labels: { type: "array", items: { type: "string", maxLength: MAX_LABEL_NAME_LENGTH }, description: "ラベル名（全件。渡した配列で置き換える）。" },
    },
    required: ["subscriptionId", "expectedName"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const target = parseTarget(args);
    if (typeof target === "string") return invalid(target);
    const patch = parseSubscriptionPatch(args);
    if (typeof patch === "string") return invalid(patch);
    if (Object.keys(patch).length === 0) return invalid("変更する項目を1つ以上指定してください");
    return updateSubscription(target, () => patch);
  },
};

export const assetManagerRecordSubscriptionCancellationTool: Tool = {
  name: "asset_manager_record_subscription_cancellation",
  description:
    "Asset Managerの契約へ、解約の記録を残す書き込みツール。**台帳の記録だけで、事業者サイトでの解約手続きそのものは行わない**" +
    "（「解約した」ではなく「解約手続き済みと記録した」と報告する）。" +
    "stage で3つの状態を区別する: " +
    "considering＝解約を検討中（cancelPlanned のみ true。自動更新・終了日は変えない）、" +
    "procedure_completed＝事業者での解約手続きが終わった（自動更新を停止し、終了日 usableUntil＝利用できる最終日を設定し、メモに手続き完了を追記する。" +
    "終了日までは利用中・過ぎると終了として表示され、停止後の更新請求は出ない）。" +
    "利用が終わった（ENDED）状態は終了日が過ぎれば自動でなるので、別途記録しない。" +
    "解約を取り消すときは asset_manager_update_subscription（cancelPlanned: false・autoRenew: true・endDate: null）を使う。" +
    "メモは既存の内容を残して1行追記する。同じ内容の再実行は status: unchanged。" +
    "呼ぶ前に asset_manager_subscriptions で対象を確かめ、subscriptionId と expectedName が一致しないと変更しない。内容を利用者に確認してから呼ぶ。",
  inputSchema: {
    type: "object",
    properties: {
      ...TARGET_PROPERTIES,
      stage: { type: "string", enum: ["considering", "procedure_completed"], description: "解約の段階。" },
      usableUntil: { type: "string", pattern: DAY_KEY_PATTERN.source, description: "procedure_completed では必須。サービスを利用できる最終日（YYYY-MM-DD）。" },
      completedOn: { type: "string", pattern: DAY_KEY_PATTERN.source, description: "解約手続きを行った日。省略可。メモに残す。" },
      note: { type: "string", maxLength: 200, description: "メモへ追記する内容（例: 公式サイトのマイページから解約手続き済み）。省略時は定型文。" },
    },
    required: ["subscriptionId", "expectedName", "stage"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const target = parseTarget(args);
    if (typeof target === "string") return invalid(target);

    const stage = args["stage"];
    if (stage !== "considering" && stage !== "procedure_completed") {
      return invalid("stage は considering または procedure_completed で指定してください");
    }
    const note = args["note"];
    if (note !== undefined && (typeof note !== "string" || note.length > 200)) return invalid("note は200文字以内の文字列で指定してください");
    if (args["completedOn"] !== undefined && !validDayKey(args["completedOn"])) return invalid("completedOn は正しい YYYY-MM-DD 形式で指定してください");

    if (stage === "considering") return updateSubscription(target, () => ({ cancelPlanned: true }));

    if (!validDayKey(args["usableUntil"])) return invalid("procedure_completed では usableUntil（利用できる最終日。YYYY-MM-DD）が必須です");
    const usableUntil = args["usableUntil"];
    const completedOn = args["completedOn"] as string | undefined;
    const line = `[解約手続き完了${completedOn ? ` ${completedOn}` : ""}] ${typeof note === "string" && note.trim() ? note.trim() : `事業者での解約手続き済み（${usableUntil}まで利用可能。台帳上の記録）`}`;

    return updateSubscription(target, (before) => {
      const existing = memoOf(before["memo"]);
      const memo = existing?.includes(line) ? existing : existing ? `${existing}\n${line}` : line;
      if (memo.length > MAX_MEMO_LENGTH) return `メモが${MAX_MEMO_LENGTH}文字を超えるため追記できません。asset_manager_update_subscription でメモを整理してください`;
      return { autoRenew: false, cancelPlanned: true, endDate: usableUntil, memo };
    });
  },
};
