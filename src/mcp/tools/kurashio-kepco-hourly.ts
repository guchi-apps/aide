import { readBillsReadConfig, type BillsConfig, type BillsFailure } from "../../core/connectors/myroom/bills.ts";
import {
  fetchKepcoHourly,
  importKepcoHourly,
  KEPCO_KWH_TOLERANCE,
  KEPCO_MAX_KWH,
  KEPCO_MAX_PERIOD_DAYS,
  readKepcoWriteConfig,
  type KepcoHourlyRecord,
  type KepcoHourlyView,
  type KepcoImportPayload,
  type KepcoMissingDay,
} from "../../core/connectors/myroom/kepco-hourly.ts";
import type { Tool, ToolResult } from "../types.ts";

/**
 * kurashio へ関西電力（はぴeみる電）の時間別kWhを登録・照会する（#692）。API契約は guchi-apps/kurashio#823。
 *
 * **読み取りと書き込みは別ツール・別scope**（`kurashio-energy:read` / `kurashio-energy:write`）。
 *
 * 安全のための作り:
 * - 入力は「抽出対象期間」と日別の24時間値だけ。CSVの先頭行（お客さま番号・住所など）は受けない
 * - `MM/DD` の年は抽出対象期間から復元する（CSVに年が無いため）
 * - 空欄（公開前）の時間は送らない。0で埋めない
 * - 既存の値は書き換えない（kurashio が `conflict` を返す。訂正は本人が kurashio の画面で行う）
 * - 登録後に照会で読み戻し、送った全時間が一致したときだけ `created` を返す
 * - 期間内に記録の無い時間が残れば `created` / `unchanged` にせず `incomplete` を返す（#690。必要な件数がそろうまで「登録済み」としない）
 * - 応答待ちが切れたら `unknown` と照会方法を返す（同じ内容の再送は `unchanged` で無害だが、先に確かめる）
 * - 結果には日付・時間・kWh・件数だけを載せる（トークンも個人情報も出さない）
 */

export const KURASHIO_ENERGY_READ = ["kurashio-energy:read"] as const;
export const KURASHIO_ENERGY_WRITE = ["kurashio-energy:write"] as const;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_DAY = /^(\d{1,2})\/(\d{1,2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface KurashioKepcoDeps {
  readConfig: () => Promise<BillsConfig | null>;
  writeConfig: () => Promise<BillsConfig | null>;
  fetchImpl?: typeof fetch;
}

const DEFAULT_DEPS: KurashioKepcoDeps = { readConfig: readBillsReadConfig, writeConfig: readKepcoWriteConfig };

function result(payload: unknown, isError = false): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

function invalid(reason: string): ToolResult {
  return result({ status: "invalid", reason }, true);
}

function failure(f: BillsFailure, extra: Record<string, unknown> = {}): ToolResult {
  return result({ status: f.kind, reason: f.reason, ...extra }, true);
}

function notConfigured(which: "read" | "write"): ToolResult {
  return result(
    {
      status: "not_configured",
      reason:
        which === "read"
          ? "AIDE に kurashio の読み取り用トークン（MYROOM_INTERNAL_API_KEY）が設定されていません"
          : "AIDE が kurashio の時間別kWh書込専用の共有トークン（MYROOM_INTERNAL_KEPCO_WRITE_API_KEY）を取得できません",
    },
    true,
  );
}

/** `YYYY-MM-DD` を実在する日付として読む。UTC正午のミリ秒を返す。 */
function parseIsoDate(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = ISO_DATE.exec(value);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(ms).toISOString().slice(0, 10) === value ? ms : null;
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 年の無い `MM/DD` を、抽出対象期間に収まる年へ復元する（年またぎでも安全）。無ければ null。 */
export function resolveMonthDay(month: number, day: number, startMs: number, endMs: number): string | null {
  const years = new Set([new Date(startMs).getUTCFullYear(), new Date(endMs).getUTCFullYear()]);
  for (const year of years) {
    const ms = Date.UTC(year, month - 1, day);
    const date = new Date(ms);
    if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) continue;
    if (ms >= startMs && ms <= endMs) return formatDate(ms);
  }
  return null;
}

type Parsed = { ok: true; payload: KepcoImportPayload } | { ok: false; result: ToolResult };

function parsePeriod(args: Record<string, unknown>, startKey: string, endKey: string) {
  const startMs = parseIsoDate(args[startKey]);
  const endMs = parseIsoDate(args[endKey]);
  if (startMs === null || endMs === null) return { error: `${startKey} と ${endKey} は YYYY-MM-DD で指定してください` };
  if (startMs > endMs) return { error: `${startKey} は ${endKey} 以前にしてください` };
  if ((endMs - startMs) / DAY_MS + 1 > KEPCO_MAX_PERIOD_DAYS) return { error: `期間は最長${KEPCO_MAX_PERIOD_DAYS}日です` };
  return { startMs, endMs, start: args[startKey] as string, end: args[endKey] as string };
}

/** 取込の引数を検証して、kurashio へ送る `date/hour/kwh` だけの形にする。 */
export function parseImportArgs(args: Record<string, unknown>): Parsed {
  const bad = (reason: string): Parsed => ({ ok: false, result: invalid(reason) });
  const period = parsePeriod(args, "periodStart", "periodEnd");
  if ("error" in period) return bad(period.error!);

  const days = args["days"];
  if (!Array.isArray(days) || days.length === 0) return bad("days は日別の時間別kWhの配列で指定してください");
  if (days.length > KEPCO_MAX_PERIOD_DAYS) return bad(`days は${KEPCO_MAX_PERIOD_DAYS}件以内にしてください`);

  const records: KepcoHourlyRecord[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of days.entries()) {
    const label = `days[${index}]`;
    const day = (raw ?? {}) as Record<string, unknown>;
    const dateText = typeof day["date"] === "string" ? day["date"].trim() : "";
    let date: string | null;
    const md = MONTH_DAY.exec(dateText);
    if (md) date = resolveMonthDay(Number(md[1]), Number(md[2]), period.startMs, period.endMs);
    else {
      const ms = parseIsoDate(dateText);
      date = ms !== null && ms >= period.startMs && ms <= period.endMs ? dateText : null;
    }
    if (!date) return bad(`${label}.date は抽出対象期間内の MM/DD か YYYY-MM-DD で指定してください`);
    if (seen.has(date)) return bad(`${label}.date が重複しています`);
    seen.add(date);

    const hourly = day["hourly"];
    if (!Array.isArray(hourly) || hourly.length !== 24) {
      return bad(`${label}.hourly は0〜23時の24個の配列で指定してください（空欄は null）`);
    }
    for (const [hour, value] of hourly.entries()) {
      // 空欄は公開前。0で埋めず、送らない。
      if (value === null) continue;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > KEPCO_MAX_KWH) {
        return bad(`${label}.hourly[${hour}] は0以上${KEPCO_MAX_KWH}以下の数値か null（空欄）にしてください`);
      }
      records.push({ date, hour, kwh: value });
    }
  }

  if (records.length === 0) {
    return {
      ok: false,
      result: result({ status: "insufficient_data", reason: "送れる値がありません（すべて空欄）。0で補わず、公開後に取得し直してください" }, true),
    };
  }
  return { ok: true, payload: { period_start: period.start, period_end: period.end, records } };
}

/** 読み戻した保存値が、送った全時間と一致するか。食い違った件数と先頭の例を返す。 */
export function verifyRecords(view: KepcoHourlyView, sent: KepcoHourlyRecord[]): { date: string; hour: number }[] {
  const stored = new Map(view.records.map((r) => [`${r.date}#${r.hour}`, r.kwh]));
  const mismatched: { date: string; hour: number }[] = [];
  for (const r of sent) {
    const kwh = stored.get(`${r.date}#${r.hour}`);
    if (kwh === undefined || Math.abs(kwh - r.kwh) > KEPCO_KWH_TOLERANCE) mismatched.push({ date: r.date, hour: r.hour });
  }
  return mismatched;
}

function missingHours(missing: KepcoMissingDay[]): number {
  return missing.reduce((sum, day) => sum + day.hours.length, 0);
}

/** 期間内に記録の無い時間が残っている。送った分が保存済みでも、期間としては登録済みにしない。 */
function incomplete(
  payload: KepcoImportPayload,
  written: boolean,
  missing: KepcoMissingDay[],
  stored: { count: number; expectedCount: number } | null,
): ToolResult {
  return result(
    {
      status: "incomplete",
      reason: written
        ? "送った時間は保存・照合済みですが、抽出対象期間に記録の無い時間が残っています。登録済みとして扱わず、公開後に期間全体を送り直してください（保存済みの時間は unchanged になります）"
        : "送った時間は既に保存済みで何も変更していませんが、抽出対象期間に記録の無い時間が残っています。登録済みとして扱わず、公開後に期間全体を送り直してください",
      written,
      periodStart: payload.period_start,
      periodEnd: payload.period_end,
      received: payload.records.length,
      ...(stored ? { stored } : {}),
      missingCount: missingHours(missing),
      missing: missing.slice(0, 62),
      lookup: lookupHint(payload),
    },
    true,
  );
}

function lookupHint(payload: KepcoImportPayload) {
  return {
    tool: "kurashio_get_kepco_hourly",
    arguments: { start: payload.period_start, end: payload.period_end },
    note: "同じ内容で再送する前に、この照会で件数・値を確かめてください（同じ内容の再送は unchanged で無害、違う値は conflict で何も書かれません）",
  };
}

export function createKurashioGetKepcoHourlyTool(deps: KurashioKepcoDeps = DEFAULT_DEPS): Tool {
  return {
    name: "kurashio_get_kepco_hourly",
    description:
      "kurashioに保存済みの関西電力（はぴeみる電）の時間別kWhを期間で読む読み取りツール。" +
      "件数（count / expectedCount）・日別合計・各時間の値・記録の無い時間（missing。0では埋めない）を返す。" +
      "期間は最長62日・未来日は不可。kurashio_import_kepco_hourly が unknown を返したときは、ここで件数・値を確かめてから再送を判断する。" +
      "Zaim由来の電気代は aide_utility_bills、月次の確定請求は kurashio_get_utility_bill。",
    requiredScopes: KURASHIO_ENERGY_READ,
    inputSchema: {
      type: "object",
      properties: {
        start: { type: "string", description: "開始日（YYYY-MM-DD）" },
        end: { type: "string", description: "終了日（YYYY-MM-DD。開始日から最長62日）" },
      },
      required: ["start", "end"],
      additionalProperties: false,
    },
    async handler(args) {
      const period = parsePeriod(args, "start", "end");
      if ("error" in period) return invalid(period.error!);
      const config = await deps.readConfig();
      if (!config) return notConfigured("read");
      const fetched = await fetchKepcoHourly(config, period.start, period.end, deps.fetchImpl);
      if (!fetched.ok) return failure(fetched);
      return result({ status: "ok", ...fetched.view });
    },
  };
}

export function createKurashioImportKepcoHourlyTool(deps: KurashioKepcoDeps = DEFAULT_DEPS): Tool {
  return {
    name: "kurashio_import_kepco_hourly",
    description:
      "関西電力（はぴeみる電）の「1時間ごとの電力量内訳」CSVから得た時間別kWhを、kurashioへ登録する書き込みツール。" +
      "入力は抽出対象期間（periodStart / periodEnd）と日別の24時間値（days）だけ。**CSVの先頭行（お客さま番号・住所・契約種別）は渡さない。** " +
      "date は CSV の MM/DD のままでよく、年は抽出対象期間から復元する。空欄（公開前）の時間は 0 にせず null にする（送られない）。" +
      "**既にある値は書き換えない。** 既存と違う時間が1つでもあれば conflict（何も書かず、既存値と送った値を返す。訂正は本人が kurashio の画面で手動CSV取込を行う）。" +
      "全て同じなら unchanged、新しい時間があれば追加して照会で読み戻し、全時間が一致し、期間内の全時間がそろったときだけ created を返す（確かめられなければ unverified。" +
      "期間内に記録の無い時間が残れば、送った分が保存済みでも incomplete を返す。登録済みとして通知しない）。" +
      "unknown が返ったら再送せず、kurashio_get_kepco_hourly で件数・値を確かめる。" +
      "dryRun:true で登録せずに、送る件数と既存値との差を確かめられる。月次の確定請求の登録（kurashio_import_utility_bill）とは別。",
    requiredScopes: KURASHIO_ENERGY_WRITE,
    inputSchema: {
      type: "object",
      properties: {
        periodStart: { type: "string", description: "CSVの「データ抽出対象期間」の開始日（YYYY-MM-DD）" },
        periodEnd: { type: "string", description: "同・終了日（YYYY-MM-DD。開始日から最長62日・未来日は不可）" },
        days: {
          type: "array",
          maxItems: KEPCO_MAX_PERIOD_DAYS,
          description: "日別の時間別kWh。CSVの日付行（抽出期間合計の行は含めない）",
          items: {
            type: "object",
            properties: {
              date: { type: "string", description: "CSVの日付（MM/DD）か YYYY-MM-DD。抽出対象期間内" },
              hourly: {
                type: "array",
                minItems: 24,
                maxItems: 24,
                description: "0-1時〜23-24時の24個。単位kWh（0〜100）。空欄は null",
                items: { type: ["number", "null"], minimum: 0, maximum: KEPCO_MAX_KWH },
              },
            },
            required: ["date", "hourly"],
            additionalProperties: false,
          },
        },
        dryRun: { type: "boolean", description: "true なら登録せず、送る件数と既存値との差を返す" },
      },
      required: ["periodStart", "periodEnd", "days"],
      additionalProperties: false,
    },
    async handler(args) {
      const parsed = parseImportArgs(args);
      if (!parsed.ok) return parsed.result;
      const payload = parsed.payload;
      const dryRun = args["dryRun"] === true;

      // 読み取り用は、dryRun の比較と登録後の読み戻しに使う。無いまま登録すると確かめようがない。
      const readConfig = await deps.readConfig();
      if (!readConfig) return notConfigured("read");

      const writeConfig = await deps.writeConfig();
      if (dryRun) {
        const existing = await fetchKepcoHourly(readConfig, payload.period_start, payload.period_end, deps.fetchImpl);
        if (!existing.ok) return failure(existing);
        const stored = new Map(existing.view.records.map((r) => [`${r.date}#${r.hour}`, r.kwh]));
        const conflicts: { date: string; hour: number; existingKwh: number; kwh: number }[] = [];
        let toCreate = 0;
        for (const r of payload.records) {
          const current = stored.get(`${r.date}#${r.hour}`);
          if (current === undefined) toCreate++;
          else if (Math.abs(current - r.kwh) > KEPCO_KWH_TOLERANCE) conflicts.push({ date: r.date, hour: r.hour, existingKwh: current, kwh: r.kwh });
        }
        return result({
          status: "dry_run",
          periodStart: payload.period_start,
          periodEnd: payload.period_end,
          sendCount: payload.records.length,
          wouldCreate: conflicts.length === 0 ? toCreate : 0,
          wouldBeUnchanged: payload.records.length - toCreate - conflicts.length,
          conflictCount: conflicts.length,
          conflicts: conflicts.slice(0, 50),
          writeConfigured: writeConfig !== null,
        });
      }
      if (!writeConfig) return notConfigured("write");

      const imported = await importKepcoHourly(writeConfig, payload, deps.fetchImpl);
      if (!imported.ok) {
        return failure(imported, imported.kind === "unknown" ? { lookup: lookupHint(payload) } : {});
      }
      if (imported.status === "conflict") {
        return result(
          {
            status: "conflict",
            reason: "既存の値と違う時間があるため、1件も登録しませんでした（上書きしていません）。訂正は本人が kurashio の画面で手動CSV取込を行ってください",
            conflictCount: imported.conflictCount,
            conflicts: imported.conflicts,
          },
          true,
        );
      }
      if (imported.status === "unchanged") {
        if (missingHours(imported.missing) > 0) return incomplete(payload, false, imported.missing, null);
        return result({ status: "unchanged", reason: "同じ内容が既に登録されています。何も変更していません", received: payload.records.length, missing: imported.missing });
      }

      // created: 正本を読み戻して、送った全時間の一致まで確かめる。確かめられなければ成功扱いにしない。
      const saved = await fetchKepcoHourly(readConfig, payload.period_start, payload.period_end, deps.fetchImpl);
      if (!saved.ok) {
        return result(
          { status: "unverified", reason: "登録の応答は返りましたが、読み戻して確かめられませんでした", lookup: lookupHint(payload) },
          true,
        );
      }
      const mismatched = verifyRecords(saved.view, payload.records);
      if (mismatched.length > 0) {
        return result(
          {
            status: "unverified",
            reason: "読み戻した値が送った内容と一致しません",
            mismatchedCount: mismatched.length,
            mismatched: mismatched.slice(0, 50),
            lookup: lookupHint(payload),
          },
          true,
        );
      }
      const stored = { count: saved.view.count, expectedCount: saved.view.expectedCount, totalKwh: saved.view.totalKwh };
      if (missingHours(saved.view.missing) > 0 || saved.view.count < saved.view.expectedCount) {
        return incomplete(payload, true, saved.view.missing, stored);
      }
      return result({
        status: "created",
        verified: true,
        created: imported.created,
        unchanged: imported.unchanged,
        stored,
      });
    },
  };
}

export const kurashioGetKepcoHourlyTool = createKurashioGetKepcoHourlyTool();
export const kurashioImportKepcoHourlyTool = createKurashioImportKepcoHourlyTool();
