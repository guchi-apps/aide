import { getSharedToken } from "../issue-deck/shared-tokens.ts";
import { DEFAULT_BASE_URL, readMyRoomConfig, TIMEOUT_MS, type MyRoomConfig } from "./index.ts";

/**
 * kurashio（旧myroom）の月次請求（電気・ガスの確定請求）を照会・登録する（aide#678・kurashio#814）。
 *
 * **正本・検証・重複判定はkurashio側に置く。** AIDEは内部APIを叩いて結果を分類するだけで、
 * 請求のDBも「同じ内容か」の判定も持たない。kurashio の取込APIは既存の行を書き換えず、
 * `created` / `duplicate` / `conflict` を返す（収集スクリプトの `POST /api/bills` は上書きなので使わない）。
 *
 * | kurashio の内部API | トークン |
 * |---|---|
 * | `GET /api/internal/bills/contracts` | 読み取り用（`MYROOM_INTERNAL_API_KEY`。`readMyRoomConfig` と共用） |
 * | `GET /api/internal/bills/record` | 同上 |
 * | `POST /api/internal/bills/import` | 書込専用（共有トークン `MYROOM_INTERNAL_BILLS_WRITE_API_KEY`） |
 *
 * **書込トークンは共有トークンだけから読み、環境変数へフォールバックしない**（#665 の方針。
 * kurashio側も同じ）。読み取り用・操作用のトークンでは登録できない。
 */

export const BILLS_WRITE_TOKEN_NAME = "MYROOM_INTERNAL_BILLS_WRITE_API_KEY";

/**
 * 取込の制限時間。読み取り（`TIMEOUT_MS`）より長くする。
 * 書き込みは途中で打ち切ると「保存されたか分からない」状態になるので、localhost で十分返る長さを取る。
 */
export const IMPORT_TIMEOUT_MS = 10_000;

export const BILL_KINDS = ["electricity", "gas"] as const;
export type BillKind = (typeof BILL_KINDS)[number];

/** 収集スクリプトと同じ、お客さま番号のハッシュ先頭12文字。番号が読めなかった契約は `default`。 */
export const CONTRACT_KEY_PATTERN = /^(?:[0-9a-f]{12}|default)$/;

export type BillsConfig = MyRoomConfig;
type FetchImpl = typeof fetch;

/** 読み取り用。部屋の状態と同じトークンで通る。 */
export function readBillsReadConfig(): Promise<BillsConfig | null> {
  return readMyRoomConfig();
}

/** 書込専用。共有トークンが取れなければ null（＝登録しに行かない）。 */
export async function readBillsWriteConfig(): Promise<BillsConfig | null> {
  const token = await getSharedToken(BILLS_WRITE_TOKEN_NAME, "aide");
  if (!token) return null;
  const baseUrl = process.env["AIDE_MYROOM_URL"] ?? DEFAULT_BASE_URL;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token };
}

export interface BillContract {
  contractKey: string;
  planName: string | null;
  latestBillingMonth: string;
}

export interface BillRecord {
  billingMonth: string;
  kind: string;
  contractKey: string;
  planName: string | null;
  amountYen: number;
  usageValue: number | null;
  usageUnit: string | null;
  receivedAt: string | null;
  updatedAt: string | null;
  revision: string | null;
}

export interface BillSource {
  sourceMessageId: string;
  sourceLabel: string | null;
  confidence: number | null;
  importedAt: string | null;
  importId: number;
}

export type BillsFailureKind =
  /** トークンが一致しない */
  | "unauthorized"
  /** kurashio が内部APIを持たないバージョン（kurashio#814 が未リリース） */
  | "unsupported"
  /** kurashio 側でトークンが未設定（503） */
  | "not_configured"
  /** kurashio の検証で弾かれた（422） */
  | "invalid"
  /** 接続できない・失敗が確かなもの。**書けていないことが確かなもの** */
  | "failed"
  /** 応答を待ちきれなかった等。**書けたかどうか分からない** */
  | "unknown";

export type BillsFailure = { ok: false; kind: BillsFailureKind; reason: string };

export type ImportStatus = "created" | "duplicate" | "conflict";

export interface ImportOutcome {
  ok: true;
  status: ImportStatus;
  record: BillRecord | null;
  source: BillSource | null;
  /** conflict のとき、食い違った項目名（`amount_yen`・`usage_value`・`usage_unit`・`source`） */
  fields?: string[];
}

/** 取込APIへ送る1件。kurashio の `InternalBillImport` と同じ形（snake_case）。 */
export interface ImportPayload {
  billing_month: string;
  kind: BillKind;
  contract_key: string;
  amount_yen: number;
  usage_value: number | null;
  usage_unit: string | null;
  plan_name: string | null;
  received_at: string | null;
  source_message_id: string;
  source_label: string | null;
  confidence: number;
}

export type BillLookup =
  | { billingMonth: string; sourceMessageId?: undefined }
  | { sourceMessageId: string; billingMonth?: undefined };

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function toBillRecord(raw: unknown): BillRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const billingMonth = str(r["billing_month"]);
  const kind = str(r["kind"]);
  const contractKey = str(r["contract_key"]);
  const amountYen = num(r["amount_yen"]);
  if (!billingMonth || !kind || !contractKey || amountYen === null) return null;
  return {
    billingMonth,
    kind,
    contractKey,
    planName: str(r["plan_name"]),
    amountYen,
    usageValue: num(r["usage_value"]),
    usageUnit: str(r["usage_unit"]),
    receivedAt: str(r["received_at"]),
    updatedAt: str(r["updated_at"]),
    revision: str(r["revision"]),
  };
}

export function toBillSource(raw: unknown): BillSource | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const sourceMessageId = str(s["source_message_id"]);
  const importId = num(s["import_id"]);
  if (!sourceMessageId || importId === null) return null;
  return {
    sourceMessageId,
    sourceLabel: str(s["source_label"]),
    confidence: num(s["confidence"]),
    importedAt: str(s["imported_at"]),
    importId,
  };
}

async function readDetail(res: Response): Promise<unknown> {
  try {
    const body = (await res.json()) as Record<string, unknown>;
    return body["detail"];
  } catch {
    return undefined;
  }
}

/**
 * HTTPの失敗を分類する。`writing` のときは、5xx（503を除く）を `unknown` に倒す。
 * kurashio は保存の失敗を rollback してから500を返すが、確定後の失敗と区別できないため。
 */
async function classifyResponse(res: Response, writing: boolean): Promise<BillsFailure> {
  const detail = await readDetail(res);
  if (res.status === 401) return { ok: false, kind: "unauthorized", reason: "HTTP 401（トークンが kurashio 側と一致しない）" };
  if (res.status === 503) return { ok: false, kind: "not_configured", reason: "HTTP 503（kurashio 側でトークンが未設定）" };
  if (res.status === 404) {
    return { ok: false, kind: "unsupported", reason: "HTTP 404（kurashio が月次請求の内部APIを持たないバージョン。guchi-apps/kurashio#814）" };
  }
  if (res.status === 422) {
    // 自前の検証は文字列、pydantic の検証は配列で返る。配列は入力値を含むので中身を出さない。
    const reason = typeof detail === "string" ? detail : "入力が kurashio の検証で弾かれました";
    return { ok: false, kind: "invalid", reason };
  }
  if (writing && res.status >= 500) {
    return { ok: false, kind: "unknown", reason: `HTTP ${res.status}。保存されたかどうかは分かりません` };
  }
  return { ok: false, kind: "failed", reason: `HTTP ${res.status}` };
}

function classifyThrown(cause: unknown, timeoutMs: number, writing: boolean): BillsFailure {
  if (cause instanceof Error && cause.name === "TimeoutError") {
    return writing
      ? { ok: false, kind: "unknown", reason: `${timeoutMs}ms 以内に応答がありませんでした。保存されたかどうかは分かりません` }
      : { ok: false, kind: "failed", reason: `${timeoutMs}ms 以内に応答がありませんでした` };
  }
  if (cause instanceof Error && cause.name === "SyntaxError") {
    return writing
      ? { ok: false, kind: "unknown", reason: "応答をJSONとして読めませんでした。保存されたかどうかは分かりません" }
      : { ok: false, kind: "failed", reason: "JSONとして読めない応答が返りました" };
  }
  // 接続そのものができていない。送れていないことが確か。
  return { ok: false, kind: "failed", reason: "kurashio へ接続できませんでした" };
}

function headers(config: BillsConfig): Record<string, string> {
  return { authorization: `Bearer ${config.token}`, accept: "application/json" };
}

/** 種別ごとの契約候補。お客さま番号は kurashio も持っておらず、返ってこない。 */
export async function fetchBillContracts(
  config: BillsConfig,
  kind: BillKind,
  fetchImpl: FetchImpl = fetch,
): Promise<{ ok: true; contracts: BillContract[] } | BillsFailure> {
  try {
    const res = await fetchImpl(`${config.baseUrl}/api/internal/bills/contracts?kind=${encodeURIComponent(kind)}`, {
      headers: headers(config),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return classifyResponse(res, false);
    const body = (await res.json()) as { contracts?: unknown };
    const contracts: BillContract[] = [];
    for (const raw of Array.isArray(body.contracts) ? body.contracts : []) {
      const c = (raw ?? {}) as Record<string, unknown>;
      const contractKey = str(c["contract_key"]);
      const latest = str(c["latest_billing_month"]);
      if (!contractKey || !latest) continue;
      contracts.push({ contractKey, planName: str(c["plan_name"]), latestBillingMonth: latest });
    }
    return { ok: true, contracts };
  } catch (cause) {
    return classifyThrown(cause, TIMEOUT_MS, false);
  }
}

/** 請求1件を、月か出典（メールID）で引く。無ければ `found: false`。 */
export async function fetchBill(
  config: BillsConfig,
  kind: BillKind,
  contractKey: string,
  lookup: BillLookup,
  fetchImpl: FetchImpl = fetch,
): Promise<{ ok: true; found: true; record: BillRecord; source: BillSource | null } | { ok: true; found: false } | BillsFailure> {
  const query = new URLSearchParams({ kind, contract_key: contractKey });
  if (lookup.billingMonth !== undefined) query.set("billing_month", lookup.billingMonth);
  else query.set("source_message_id", lookup.sourceMessageId);
  try {
    const res = await fetchImpl(`${config.baseUrl}/api/internal/bills/record?${query}`, {
      headers: headers(config),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) {
      // 未登録は `{"detail":"not_found"}`。FastAPI のルート無しは `{"detail":"Not Found"}` で、未対応のバージョン。
      const detail = await readDetail(res.clone());
      if (detail === "not_found") return { ok: true, found: false };
    }
    if (!res.ok) return classifyResponse(res, false);
    const body = (await res.json()) as { record?: unknown; source?: unknown };
    const record = toBillRecord(body.record);
    if (!record) return { ok: false, kind: "failed", reason: "kurashio の応答に請求が含まれていませんでした" };
    return { ok: true, found: true, record, source: toBillSource(body.source) };
  } catch (cause) {
    return classifyThrown(cause, TIMEOUT_MS, false);
  }
}

/** 請求を1件、上書きせずに登録する。判定は kurashio 側。 */
export async function importBill(
  config: BillsConfig,
  payload: ImportPayload,
  fetchImpl: FetchImpl = fetch,
): Promise<ImportOutcome | BillsFailure> {
  try {
    const res = await fetchImpl(`${config.baseUrl}/api/internal/bills/import`, {
      method: "POST",
      headers: { ...headers(config), "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(IMPORT_TIMEOUT_MS),
    });
    if (!res.ok) return classifyResponse(res, true);
    const body = (await res.json()) as Record<string, unknown>;
    const status = body["status"];
    if (status === "mock_ok") {
      return { ok: false, kind: "failed", reason: "kurashio がモック（DB_MOCK）で動いており、保存していません" };
    }
    if (status !== "created" && status !== "duplicate" && status !== "conflict") {
      return { ok: false, kind: "unknown", reason: "kurashio が想定外の結果を返しました。保存されたかどうかは分かりません" };
    }
    const fields = Array.isArray(body["fields"]) ? body["fields"].filter((f): f is string => typeof f === "string") : undefined;
    return {
      ok: true,
      status,
      record: toBillRecord(body["record"]),
      source: toBillSource(body["source"]),
      ...(fields ? { fields } : {}),
    };
  } catch (cause) {
    return classifyThrown(cause, IMPORT_TIMEOUT_MS, true);
  }
}
