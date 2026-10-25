import { getSharedToken } from "../issue-deck/shared-tokens.ts";
import {
  classifyResponse,
  classifyThrown,
  headers,
  IMPORT_TIMEOUT_MS,
  type BillsConfig,
  type BillsFailure,
} from "./bills.ts";
import { DEFAULT_BASE_URL, TIMEOUT_MS } from "./index.ts";

/**
 * kurashio（旧myroom）の関西電力 時間別kWhを照会・登録する（aide#692・kurashio#823）。
 *
 * **正本・検証・重複判定はkurashio側に置く。** kurashio の取込APIは既存の値を書き換えず、
 * `created` / `unchanged` / `conflict` を返す（画面の手動CSV取込は上書き型なので使わない）。
 * 失敗の分類（`unknown` は「保存されたか分からない」）は月次請求（`bills.ts`）と同じ。
 *
 * | kurashio の内部API | トークン |
 * |---|---|
 * | `GET /api/internal/energy/kepco-hourly` | 読み取り用（`MYROOM_INTERNAL_API_KEY`。`readBillsReadConfig` と共用） |
 * | `POST /api/internal/energy/kepco-hourly/import` | 書込専用（共有トークン `MYROOM_INTERNAL_KEPCO_WRITE_API_KEY`） |
 *
 * **書込トークンは共有トークンだけから読み、環境変数へフォールバックしない**（bills と同じ方針）。
 */

export const KEPCO_WRITE_TOKEN_NAME = "MYROOM_INTERNAL_KEPCO_WRITE_API_KEY";

/** kurashio の上限（`MAX_PERIOD_DAYS`・`MAX_KWH`）。AIDE側でも先に弾く。 */
export const KEPCO_MAX_PERIOD_DAYS = 62;
export const KEPCO_MAX_KWH = 100;
/** kurashio の同値判定の幅（CSVは小数2桁。保存値との丸め差だけを同値とみなす） */
export const KEPCO_KWH_TOLERANCE = 0.0005;

export async function readKepcoWriteConfig(): Promise<BillsConfig | null> {
  const token = await getSharedToken(KEPCO_WRITE_TOKEN_NAME, "aide");
  if (!token) return null;
  const baseUrl = process.env["AIDE_MYROOM_URL"] ?? DEFAULT_BASE_URL;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token };
}

/** 取込APIへ送る1件。kurashio の `KepcoHourlyRecord` と同じ形。 */
export interface KepcoHourlyRecord {
  date: string;
  hour: number;
  kwh: number;
}

export interface KepcoImportPayload {
  period_start: string;
  period_end: string;
  records: KepcoHourlyRecord[];
}

export interface KepcoMissingDay {
  date: string;
  hours: number[];
}

export interface KepcoConflict {
  date: string;
  hour: number;
  existingKwh: number;
  kwh: number;
}

export type KepcoImportStatus = "created" | "unchanged" | "conflict";

export interface KepcoImportOutcome {
  ok: true;
  status: KepcoImportStatus;
  created: number;
  unchanged: number;
  conflictCount: number;
  conflicts: KepcoConflict[];
  missing: KepcoMissingDay[];
}

export interface KepcoHourlyView {
  start: string;
  end: string;
  count: number;
  expectedCount: number;
  totalKwh: number;
  days: { date: string; count: number; totalKwh: number }[];
  records: { date: string; hour: number; kwh: number; importedAt: string | null }[];
  missing: KepcoMissingDay[];
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toMissing(value: unknown): KepcoMissingDay[] {
  const result: KepcoMissingDay[] = [];
  for (const raw of list(value)) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const date = str(r["date"]);
    if (!date) continue;
    result.push({ date, hours: list(r["hours"]).filter((h): h is number => typeof h === "number") });
  }
  return result;
}

/** 404 は bills 向けの文言になっているので、この経路用に言い直す。 */
function reclassify(f: BillsFailure): BillsFailure {
  if (f.kind === "unsupported") {
    return { ok: false, kind: "unsupported", reason: "HTTP 404（kurashio が時間別kWhの内部APIを持たないバージョン。guchi-apps/kurashio#823 が未リリース）" };
  }
  return f;
}

/** 期間内の保存値を読む。取込の結果を確かめるときにも使う。 */
export async function fetchKepcoHourly(
  config: BillsConfig,
  start: string,
  end: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; view: KepcoHourlyView } | BillsFailure> {
  const query = new URLSearchParams({ start, end });
  try {
    const res = await fetchImpl(`${config.baseUrl}/api/internal/energy/kepco-hourly?${query}`, {
      headers: headers(config),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return reclassify(await classifyResponse(res, false));
    const body = (await res.json()) as Record<string, unknown>;
    const count = num(body["count"]);
    if (count === null) return { ok: false, kind: "failed", reason: "kurashio の応答に件数が含まれていませんでした" };
    const days = list(body["days"]).flatMap((raw) => {
      const d = (raw ?? {}) as Record<string, unknown>;
      const date = str(d["date"]);
      const dayCount = num(d["count"]);
      const total = num(d["total_kwh"]);
      return date && dayCount !== null && total !== null ? [{ date, count: dayCount, totalKwh: total }] : [];
    });
    const records = list(body["records"]).flatMap((raw) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      const date = str(r["date"]);
      const hour = num(r["hour"]);
      const kwh = num(r["kwh"]);
      return date && hour !== null && kwh !== null ? [{ date, hour, kwh, importedAt: str(r["imported_at"]) }] : [];
    });
    return {
      ok: true,
      view: {
        start: str(body["start"]) ?? start,
        end: str(body["end"]) ?? end,
        count,
        expectedCount: num(body["expected_count"]) ?? 0,
        totalKwh: num(body["total_kwh"]) ?? 0,
        days,
        records,
        missing: toMissing(body["missing"]),
      },
    };
  } catch (cause) {
    return classifyThrown(cause, TIMEOUT_MS, false);
  }
}

/** 時間別kWhを上書きせずに登録する。判定は kurashio 側。 */
export async function importKepcoHourly(
  config: BillsConfig,
  payload: KepcoImportPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<KepcoImportOutcome | BillsFailure> {
  try {
    const res = await fetchImpl(`${config.baseUrl}/api/internal/energy/kepco-hourly/import`, {
      method: "POST",
      headers: { ...headers(config), "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(IMPORT_TIMEOUT_MS),
    });
    if (!res.ok) return reclassify(await classifyResponse(res, true));
    const body = (await res.json()) as Record<string, unknown>;
    const status = body["status"];
    if (status === "mock_ok") {
      return { ok: false, kind: "failed", reason: "kurashio がモック（DB_MOCK）で動いており、保存していません" };
    }
    if (status !== "created" && status !== "unchanged" && status !== "conflict") {
      return { ok: false, kind: "unknown", reason: "kurashio が想定外の結果を返しました。保存されたかどうかは分かりません" };
    }
    const conflicts = list(body["conflicts"]).flatMap((raw) => {
      const c = (raw ?? {}) as Record<string, unknown>;
      const date = str(c["date"]);
      const hour = num(c["hour"]);
      const existing = num(c["existing_kwh"]);
      const kwh = num(c["kwh"]);
      return date && hour !== null && existing !== null && kwh !== null ? [{ date, hour, existingKwh: existing, kwh }] : [];
    });
    return {
      ok: true,
      status,
      created: num(body["created"]) ?? 0,
      unchanged: num(body["unchanged"]) ?? 0,
      conflictCount: num(body["conflict_count"]) ?? conflicts.length,
      conflicts,
      missing: toMissing(body["missing"]),
    };
  } catch (cause) {
    return classifyThrown(cause, IMPORT_TIMEOUT_MS, true);
  }
}
