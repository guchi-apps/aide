import { getSharedToken } from "../issue-deck/shared-tokens.ts";
import { DEFAULT_BASE_URL, TIMEOUT_MS } from "./index.ts";
import { readDaySpanWriteConfig, isRealDate } from "./write.ts";

/**
 * YoteiFlow（DaySpan）の移動（TravelPlan）の作成と読戻し（aide#707、起点: yoteiflow#1432）。
 *
 * 正本は dayspan の docs/internal-api.md「POST /api/internal/travels」。
 * 通常のGoogleカレンダー予定（`aide_create_event`）では移動にならないため、専用APIだけを通す。
 *
 * - 作成は**予定の書込鍵**（`AIDE_DAYSPAN_WRITE_TOKEN`）。YoteiFlowの契約がこの鍵を要求する
 *   ので新しい秘密値は増やさない。MCP側の権限分離はOAuth scope `travel:write` が担う
 * - 読戻しは読取鍵（`AIDE_DAYSPAN_TOKEN`）。読取鍵では書けない
 * - 対象ユーザーは `AIDE_DAYSPAN_TARGET_EMAIL` 固定。引数には持たない
 * - メモ（便名・座席・予約番号など）は**ログに出さない**。ここでは何もログへ出力しない
 */

export const TRAVEL_MODES = ["CAR", "PUBLIC_TRANSIT", "WALK", "OTHER"] as const;
export type TravelMode = (typeof TRAVEL_MODES)[number];

const MAX_VIA = 10;
const MAX_PLACE = 200;
const MAX_NOTE = 2000;
/** YoteiFlow側（印字可能ASCII・191文字まで）に合わせる。 */
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,191}$/;
/** タイムゾーン（Z か ±hh:mm）が無い日時は曖昧なので弾く。 */
const DATETIME = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;

export interface CreateTravelInput {
  origin: string;
  destination: string;
  via?: string[];
  mode: TravelMode;
  departAt: string;
  arriveAt: string;
  note?: string;
  confirmDuplicate?: boolean;
}

function datetime(value: unknown, name: string): { ms: number } | { error: string } {
  const match = typeof value === "string" ? DATETIME.exec(value) : null;
  if (!match || !isRealDate(match[1]!) || Number.isNaN(Date.parse(value as string))) {
    return { error: `${name} は YYYY-MM-DDTHH:MM(:SS)+09:00 のようにタイムゾーン付きの実在する日時で指定してください` };
  }
  return { ms: Date.parse(value as string) };
}

function place(value: unknown, name: string): string | { error: string } {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return { error: `${name} が必要です` };
  if (text.length > MAX_PLACE) return { error: `${name} は${MAX_PLACE}文字以内で指定してください` };
  return text;
}

/** 受け取った引数を検査して送る内容へ変換する。YoteiFlow側の検査と同じ基準にそろえる。 */
export function normalizeCreateTravelInput(
  raw: Record<string, unknown>,
): { input: CreateTravelInput; idempotencyKey: string } | { error: string } {
  const origin = place(raw["origin"], "origin");
  if (typeof origin !== "string") return origin;
  const destination = place(raw["destination"], "destination");
  if (typeof destination !== "string") return destination;

  const mode = raw["mode"];
  if (typeof mode !== "string" || !(TRAVEL_MODES as readonly string[]).includes(mode)) {
    return {
      error:
        `mode は ${TRAVEL_MODES.join(" / ")} のいずれかで指定してください` +
        "（航空便・船・新幹線などは PUBLIC_TRANSIT にせず、実態に近い値を利用者に確認してください）",
    };
  }

  let via: string[] | undefined;
  if (raw["via"] !== undefined) {
    const list = raw["via"];
    if (!Array.isArray(list) || list.length > MAX_VIA) return { error: `via は${MAX_VIA}件以内の文字列配列で指定してください` };
    via = [];
    for (const item of list) {
      const p = place(item, "via の要素");
      if (typeof p !== "string") return p;
      via.push(p);
    }
  }

  const depart = datetime(raw["departAt"], "departAt");
  if ("error" in depart) return depart;
  const arrive = datetime(raw["arriveAt"], "arriveAt");
  if ("error" in arrive) return arrive;
  if (arrive.ms <= depart.ms) return { error: "arriveAt は departAt より後にしてください" };

  let note: string | undefined;
  if (raw["note"] !== undefined) {
    if (typeof raw["note"] !== "string" || raw["note"].length > MAX_NOTE) {
      return { error: `note は${MAX_NOTE}文字以内の文字列で指定してください` };
    }
    note = raw["note"].trim() || undefined;
  }

  if (raw["confirmDuplicate"] !== undefined && typeof raw["confirmDuplicate"] !== "boolean") {
    return { error: "confirmDuplicate は真偽値で指定してください" };
  }

  const key = raw["idempotencyKey"];
  if (typeof key !== "string" || !IDEMPOTENCY_KEY.test(key)) {
    return { error: "idempotencyKey が必要です（印字可能ASCIIの8〜191文字。再送でも同じ値を使う）" };
  }

  return {
    idempotencyKey: key,
    input: {
      origin,
      destination,
      ...(via && via.length ? { via } : {}),
      mode: mode as TravelMode,
      departAt: raw["departAt"] as string,
      arriveAt: raw["arriveAt"] as string,
      ...(note ? { note } : {}),
      ...(raw["confirmDuplicate"] === true ? { confirmDuplicate: true } : {}),
    },
  };
}

export type TravelFailureKind =
  | "unauthorized"
  | "invalid"
  | "not_found"
  | "duplicate"
  | "idempotency_conflict"
  | "in_progress"
  | "unavailable"
  | "result_unknown";

export type TravelApiResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; kind: TravelFailureKind; reason: string; body?: Record<string, unknown> };

function classify(status: number, body: Record<string, unknown> | null): TravelFailureKind {
  const code = typeof body?.["error"] === "string" ? body["error"] : "";
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 503) return "unavailable";
  if (status === 404) return "not_found";
  if (status === 400) return "invalid";
  if (status === 409) {
    if (code === "duplicate_travel") return "duplicate";
    if (code === "operation_in_progress") return "in_progress";
    return "idempotency_conflict";
  }
  // 5xx・想定外は保存されたか不明。作り直さず同じキーで再送させる。
  return "result_unknown";
}

async function call(
  base: { baseUrl: string; token: string; targetEmail: string },
  path: string,
  init: { method: "GET" | "POST"; headers?: Record<string, string>; body?: string },
): Promise<TravelApiResult> {
  try {
    const res = await fetch(`${base.baseUrl}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${base.token}`,
        "x-target-email": base.targetEmail,
        accept: "application/json",
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const parsed: unknown = await res.json().catch(() => null);
    const body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    if (res.ok) return body ? { ok: true, body } : { ok: false, kind: "result_unknown", reason: "応答を読み取れなかった" };
    return { ok: false, kind: classify(res.status, body), reason: `HTTP ${res.status}`, ...(body ? { body } : {}) };
  } catch (cause) {
    const reason = cause instanceof Error && cause.name === "TimeoutError" ? `${TIMEOUT_MS}ms 以内に応答しなかった` : "接続できなかった";
    // 書込は届いたか分からない。読戻し(GET)でもこの区分で返し、呼び出し側が文脈で言い分ける。
    return { ok: false, kind: "result_unknown", reason };
  }
}

export async function createTravel(input: CreateTravelInput, idempotencyKey: string): Promise<TravelApiResult | "unconfigured"> {
  const config = await readDaySpanWriteConfig();
  if (!config) return "unconfigured";
  return call(config, "/api/internal/travels", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify(input),
  });
}

export async function getTravel(travelId: string): Promise<TravelApiResult | "unconfigured"> {
  const shared = await getSharedToken("DAYSPAN_INTERNAL_API_KEY", "aide");
  const token = shared || process.env["AIDE_DAYSPAN_TOKEN"];
  const targetEmail = process.env["AIDE_DAYSPAN_TARGET_EMAIL"];
  if (!token || !targetEmail) return "unconfigured";
  const baseUrl = (process.env["AIDE_DAYSPAN_URL"] ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  return call({ baseUrl, token, targetEmail }, `/api/internal/travels/${encodeURIComponent(travelId)}`, { method: "GET" });
}
