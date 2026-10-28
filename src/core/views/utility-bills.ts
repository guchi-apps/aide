import { tokyoDate } from "../tokyo-date.ts";
import {
  fetchBill,
  fetchBillContracts,
  readBillsReadConfig,
  type BillContract,
  type BillRecord,
  type BillsConfig,
} from "../connectors/myroom/bills.ts";

/**
 * 電気代・ガス代の横断ビュー（aide#324）。
 *
 * **情報源は kurashio の月次請求**（`src/core/connectors/myroom/bills.ts`。aide#678）。
 * もとはZaim公式APIの支出をジャンル名で拾っていたが、公式APIの終了（2026-12-07）で
 * kurashio へ移した（aide#714。`docs/zaim-api-shutdown.md`）。
 *
 * **月は請求月（メールの「◯月分」）で束ねる。** kurashio は請求を契約・請求月ごとに1件で持ち、
 * 金額・使用量も請求そのものの値なので、Zaim時代のように品名から使用量を読む必要は無い。
 * kurashio に値が無い項目は `null` のまま返し、推測しない。
 *
 * kurashio の内部APIは「契約・請求月を指定して1件」しか引けないため、契約ごとに期間の
 * 月数ぶん問い合わせる（同じホストの内部APIなので、逐次で足りる）。
 */

export type UtilityKind = "electricity" | "gas";

export const UTILITY_KINDS: readonly UtilityKind[] = ["electricity", "gas"];

const KIND_LABELS: Record<UtilityKind, string> = { electricity: "電気", gas: "ガス" };

/** 既定で読む月数。前年同月と比べられるよう13か月にしている。 */
export const DEFAULT_MONTHS = 13;
export const MAX_MONTHS = 36;

export interface UtilityUsage {
  value: number;
  /** `kWh` または `m3`。 */
  unit: string;
}

export interface UtilityBill {
  /** 請求月（`YYYY-MM`。メールの「◯月分」）。 */
  billingMonth: string;
  /** kurashio の契約キー（お客さま番号のハッシュ先頭12文字。番号が無い契約は `default`）。 */
  contractKey: string;
  planName: string | null;
  amount: number;
  usage: UtilityUsage | null;
  /** 請求メールの受信時刻。kurashio に無ければ null。 */
  receivedAt: string | null;
}

export interface UtilityMonth {
  /** 請求月（`YYYY-MM`）。 */
  month: string;
  amount: number;
  /** その月の請求の件数。2件以上なら、契約が複数ある。 */
  count: number;
  /** その月のすべての請求に同じ単位の使用量があるときだけ合計を入れる。 */
  usage: UtilityUsage | null;
}

export interface UtilityComparison {
  month: string;
  amount: number;
  usage: UtilityUsage | null;
  /** 直近の月から見た差（直近 − 比較先）。 */
  amountDiff: number;
  /** 使用量の差。どちらかが無い・単位が違うときは null。 */
  usageDiff: number | null;
}

export interface UtilityKindView {
  kind: UtilityKind;
  label: string;
  /** 対象にした kurashio の契約。空ならその種類の請求が kurashio に1件も無い。 */
  contracts: BillContract[];
  /** 最も新しい請求。 */
  latest: UtilityBill | null;
  /** 月ごとの合計。新しい順。請求の無い月は含めない。 */
  monthly: UtilityMonth[];
  comparison: {
    /** 直近の月の1つ前の月（請求がある月に限らず、暦の前月）。 */
    previousMonth: UtilityComparison | null;
    /** 直近の月の前年同月。 */
    sameMonthLastYear: UtilityComparison | null;
  };
  /** 請求がある月の平均額（円・整数に丸める）。 */
  averageMonthlyAmount: number | null;
  /** 期間内の請求そのもの。新しい順。 */
  bills: UtilityBill[];
  /** 取得できなかった理由。取得できていれば null。 */
  unavailable: string | null;
}

export interface UtilityBillsView {
  configured: boolean;
  /** 読んだ請求月の範囲（`YYYY-MM`）。 */
  period: { startMonth: string; endMonth: string; months: number };
  kinds: UtilityKindView[];
  note: string;
}

/** 浮動小数の誤差を落とす（使用量は小数1〜2桁まで）。 */
const round = (value: number): number => Math.round(value * 100) / 100;

/** kurashio の単位表記（`kWh`・`m³` など）を `kWh` / `m3` へ寄せる。読めない単位は null。 */
export function normalizeUnit(unit: string | null): string | null {
  if (!unit) return null;
  const normalized = unit.normalize("NFKC").replace(/\s+/g, "").replace(/m³|立方メートル/g, "m3");
  if (/^kwh$/i.test(normalized)) return "kWh";
  if (/^m3$/i.test(normalized)) return "m3";
  return null;
}

export function toUtilityBill(record: BillRecord): UtilityBill {
  const unit = normalizeUnit(record.usageUnit);
  return {
    billingMonth: record.billingMonth,
    contractKey: record.contractKey,
    planName: record.planName,
    amount: record.amountYen,
    // 値と単位の両方が読めたときだけ。片方しか無いものを補わない。
    usage: record.usageValue !== null && unit ? { value: record.usageValue, unit } : null,
    receivedAt: record.receivedAt,
  };
}

/** `YYYY-MM` に月数を足す（負数で遡る）。 */
export function shiftMonth(month: string, delta: number): string {
  const [year, m] = month.split("-").map(Number) as [number, number];
  const index = year * 12 + (m - 1) + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

function summarizeMonths(bills: readonly UtilityBill[]): UtilityMonth[] {
  const byMonth = new Map<string, UtilityBill[]>();
  for (const bill of bills) {
    byMonth.set(bill.billingMonth, [...(byMonth.get(bill.billingMonth) ?? []), bill]);
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([month, items]) => {
      const unit = items[0]?.usage?.unit;
      const usage =
        unit && items.every((item) => item.usage?.unit === unit)
          ? { value: round(items.reduce((total, item) => total + item.usage!.value, 0)), unit }
          : null;
      return { month, amount: items.reduce((total, item) => total + item.amount, 0), count: items.length, usage };
    });
}

function compare(latest: UtilityMonth, other: UtilityMonth | undefined): UtilityComparison | null {
  if (!other) return null;
  return {
    month: other.month,
    amount: other.amount,
    usage: other.usage,
    amountDiff: latest.amount - other.amount,
    usageDiff:
      latest.usage && other.usage && latest.usage.unit === other.usage.unit
        ? round(latest.usage.value - other.usage.value)
        : null,
  };
}

/**
 * 請求を1種類ぶんへ畳む。**純粋関数。テストはここに集中する。**
 */
export function summarizeUtilityKind(
  kind: UtilityKind,
  contracts: BillContract[],
  bills: readonly UtilityBill[],
): UtilityKindView {
  const sorted = [...bills].sort(
    (a, b) => b.billingMonth.localeCompare(a.billingMonth) || a.contractKey.localeCompare(b.contractKey),
  );
  const monthly = summarizeMonths(sorted);
  const latestMonth = monthly[0];
  const find = (month: string) => monthly.find((item) => item.month === month);

  return {
    kind,
    label: KIND_LABELS[kind],
    contracts,
    latest: sorted[0] ?? null,
    monthly,
    comparison: {
      previousMonth: latestMonth ? compare(latestMonth, find(shiftMonth(latestMonth.month, -1))) : null,
      sameMonthLastYear: latestMonth ? compare(latestMonth, find(shiftMonth(latestMonth.month, -12))) : null,
    },
    averageMonthlyAmount:
      monthly.length > 0 ? Math.round(monthly.reduce((total, item) => total + item.amount, 0) / monthly.length) : null,
    bills: sorted,
    unavailable: null,
  };
}

/** 読む期間。今月（JST）を含めて `months` か月ぶんの請求月。 */
export function utilityPeriod(now: Date, months: number): UtilityBillsView["period"] {
  const endMonth = tokyoDate(now).slice(0, 7);
  return { startMonth: shiftMonth(endMonth, -(months - 1)), endMonth, months };
}

/** 期間内の請求月。新しい順。 */
export function periodMonths(period: UtilityBillsView["period"]): string[] {
  return Array.from({ length: period.months }, (_, index) => shiftMonth(period.endMonth, -index));
}

function unavailableKind(kind: UtilityKind, reason: string, contracts: BillContract[] = []): UtilityKindView {
  return { ...summarizeUtilityKind(kind, contracts, []), unavailable: reason };
}

const NOTE = [
  "kurashio に保存された電気・ガスの月次請求から読む。month・billingMonth は請求月（メールの「◯月分」）で、検針期間・受信日ではない。",
  "使用量（usage）は請求に書かれていたときだけ入る。無い月は null で、推測値ではない。",
  "kurashio に請求が取り込まれていない月は monthly に出てこない（請求が無いという意味ではない）。",
].join(" ");

export interface BuildUtilityBillsOptions {
  kinds?: readonly UtilityKind[];
  months?: number;
  now?: Date;
  /** テスト用の差し替え。 */
  config?: BillsConfig | null;
  fetchImpl?: typeof fetch;
}

async function readKind(
  config: BillsConfig,
  kind: UtilityKind,
  months: readonly string[],
  fetchImpl: typeof fetch | undefined,
): Promise<UtilityKindView> {
  const contracts = await fetchBillContracts(config, kind, fetchImpl);
  if (!contracts.ok) return unavailableKind(kind, `kurashio の契約一覧を取得できなかった: ${contracts.reason}`);
  if (contracts.contracts.length === 0) {
    return unavailableKind(kind, `kurashio に${KIND_LABELS[kind]}の請求が1件も無い`);
  }

  const bills: UtilityBill[] = [];
  for (const contract of contracts.contracts) {
    for (const month of months) {
      // 最新の請求月より先の月は問い合わせない（まだ届いていない）。
      if (month > contract.latestBillingMonth) continue;
      const outcome = await fetchBill(config, kind, contract.contractKey, { billingMonth: month }, fetchImpl);
      // 一部の月だけ欠けた推移を出すと、無い月を「請求が無かった」と読まれる。種類ごと取得失敗にする。
      if (!outcome.ok) {
        return unavailableKind(kind, `kurashio の請求（${month}）を取得できなかった: ${outcome.reason}`, contracts.contracts);
      }
      if (outcome.found) bills.push(toUtilityBill(outcome.record));
    }
  }
  return summarizeUtilityKind(kind, contracts.contracts, bills);
}

/**
 * 電気代・ガス代を読む。**失敗しても例外を投げない**（種類ごとに `unavailable` へ理由を入れる）。
 */
export async function buildUtilityBills(options: BuildUtilityBillsOptions = {}): Promise<UtilityBillsView> {
  const kinds = options.kinds ?? UTILITY_KINDS;
  const period = utilityPeriod(options.now ?? new Date(), options.months ?? DEFAULT_MONTHS);
  const config = options.config === undefined ? await readBillsReadConfig() : options.config;

  if (!config) {
    return {
      configured: false,
      period,
      kinds: kinds.map((kind) => unavailableKind(kind, "kurashio の接続設定が無い")),
      note: "kurashio の読み取り用トークンが設定されていないため、電気代・ガス代を取得できない。請求が無いという意味ではない。",
    };
  }

  const months = periodMonths(period);
  const views: UtilityKindView[] = [];
  for (const kind of kinds) views.push(await readKind(config, kind, months, options.fetchImpl));
  return { configured: true, period, kinds: views, note: NOTE };
}
