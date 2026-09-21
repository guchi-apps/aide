import { tokyoDate } from "../tokyo-date.ts";
import { loadZaimOAuthCredentials, type ZaimOAuthCredentials } from "../connectors/zaim/oauth.ts";
import { fetchZaimPayments, type ZaimApiPayment } from "../connectors/zaim/read.ts";
import type { ZaimMaster } from "../connectors/zaim/write.ts";
import { readZaimMaster } from "./zaim-master.ts";

/**
 * 電気代・ガス代の横断ビュー（aide#324）。
 *
 * 情報源はZaim公式APIの支出。電気・ガスの請求メールは ChatGPT → `asset_manager_import_payment`
 * → Asset Manager → Zaim とAPI経由で登録されるため、公式APIで期間を指定して読める
 * （`src/core/connectors/zaim/read.ts`）。Asset Manager には読み取りAPIが無く、
 * Web版の一覧のキャッシュは当月＋先月ぶんしか持たないため、どちらも推移に使えない。
 *
 * **どの明細が電気・ガスかは、Zaimのジャンル名で決める**（「電気」「ガス」を含むジャンル）。
 * 品名（`name`）や店名での名寄せはしない。「ガス」を含む店名（飲食店など）を拾うため。
 *
 * **使用量は品名から読む。** Asset Manager は使用量を品名の末尾へ足して登録する
 * （「電気料金 258kWh」。asset-manager#307）。書かれていない月は `usage: null` のまま返し、推測しない。
 *
 * **検針期間（対象期間）は持っていない。** Zaimの明細は日付を1つしか持たず、その日付は
 * 請求メールから読んだ請求・支払の日である。月ごとの集計はこの日付の月で束ねている。
 */

export type UtilityKind = "electricity" | "gas";

export const UTILITY_KINDS: readonly UtilityKind[] = ["electricity", "gas"];

const KIND_LABELS: Record<UtilityKind, string> = { electricity: "電気", gas: "ガス" };

/** ジャンル名にこれを含めば、その種類の明細とみなす。 */
const GENRE_PATTERNS: Record<UtilityKind, RegExp> = { electricity: /電気/, gas: /ガス/ };

/** 既定で読む月数。前年同月と比べられるよう13か月にしている。 */
export const DEFAULT_MONTHS = 13;
export const MAX_MONTHS = 36;

export interface UtilityUsage {
  value: number;
  /** `kWh` または `m3`。 */
  unit: string;
}

export interface UtilityBill {
  /** Zaimに登録された日付（請求・支払の日）。検針期間ではない。 */
  date: string;
  amount: number;
  usage: UtilityUsage | null;
  name: string;
  place: string;
}

export interface UtilityMonth {
  /** `YYYY-MM`（明細の日付の月）。 */
  month: string;
  amount: number;
  /** その月の明細の件数。2件以上なら、請求が同じ月に重なったか分割されている。 */
  count: number;
  /** その月のすべての明細に同じ単位の使用量が書かれているときだけ合計を入れる。 */
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
  /** 対象にしたZaimのジャンル。空ならその種類のジャンルが見つからなかった。 */
  genres: { id: number; name: string; category: string }[];
  /** 最も新しい明細。 */
  latest: UtilityBill | null;
  /** 月ごとの合計。新しい順。明細の無い月は含めない。 */
  monthly: UtilityMonth[];
  comparison: {
    /** 直近の月の1つ前の月（明細がある月に限らず、暦の前月）。 */
    previousMonth: UtilityComparison | null;
    /** 直近の月の前年同月。 */
    sameMonthLastYear: UtilityComparison | null;
  };
  /** 明細がある月の平均額（円・整数に丸める）。 */
  averageMonthlyAmount: number | null;
  /** 期間内の明細そのもの。新しい順。 */
  bills: UtilityBill[];
  /** 読める上限に達し、古い明細が漏れている可能性がある。 */
  truncated: boolean;
  /** 取得できなかった理由。取得できていれば null。 */
  unavailable: string | null;
}

export interface UtilityBillsView {
  configured: boolean;
  period: { startDate: string; endDate: string; months: number };
  kinds: UtilityKindView[];
  note: string;
}

/** 全角・㎥ などを半角へ寄せてから、`258kWh`・`21.4m3` の形を探す。 */
export function parseUsage(text: string): UtilityUsage | null {
  const normalized = text.normalize("NFKC").replace(/m³|立方メートル/g, "m3");
  const match = /(\d+(?:\.\d+)?)\s*(kwh|m\s*3)(?![\w])/i.exec(normalized);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  return { value, unit: /kwh/i.test(match[2]!) ? "kWh" : "m3" };
}

/** 浮動小数の誤差を落とす（使用量は小数1〜2桁まで）。 */
const round = (value: number): number => Math.round(value * 100) / 100;

function toBill(payment: ZaimApiPayment): UtilityBill {
  return {
    date: payment.date,
    amount: payment.amount,
    usage: parseUsage(payment.name) ?? parseUsage(payment.comment),
    name: payment.name,
    place: payment.place,
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
    const month = bill.date.slice(0, 7);
    byMonth.set(month, [...(byMonth.get(month) ?? []), bill]);
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
 * ジャンルに当たった明細を1種類ぶんへ畳む。**純粋関数。テストはここに集中する。**
 */
export function summarizeUtilityKind(
  kind: UtilityKind,
  genres: UtilityKindView["genres"],
  payments: readonly ZaimApiPayment[],
  truncated = false,
): UtilityKindView {
  const bills = payments
    .map(toBill)
    .sort((a, b) => b.date.localeCompare(a.date) || b.amount - a.amount);
  const monthly = summarizeMonths(bills);
  const latestMonth = monthly[0];
  const find = (month: string) => monthly.find((item) => item.month === month);

  return {
    kind,
    label: KIND_LABELS[kind],
    genres,
    latest: bills[0] ?? null,
    monthly,
    comparison: {
      previousMonth: latestMonth ? compare(latestMonth, find(shiftMonth(latestMonth.month, -1))) : null,
      sameMonthLastYear: latestMonth ? compare(latestMonth, find(shiftMonth(latestMonth.month, -12))) : null,
    },
    averageMonthlyAmount:
      monthly.length > 0 ? Math.round(monthly.reduce((total, item) => total + item.amount, 0) / monthly.length) : null,
    bills,
    truncated,
    unavailable: null,
  };
}

/** マスタから、その種類にあたるジャンルを探す。 */
export function findUtilityGenres(master: ZaimMaster, kind: UtilityKind): UtilityKindView["genres"] {
  const categories = new Map(master.categories.map((category) => [category.id, category.name]));
  return master.genres
    .filter((genre) => GENRE_PATTERNS[kind].test(genre.name))
    .map((genre) => ({ id: genre.id, name: genre.name, category: categories.get(genre.categoryId) ?? "" }));
}

/** 読む期間。`months` か月前の月初から今日（JST）まで。 */
export function utilityPeriod(now: Date, months: number): UtilityBillsView["period"] {
  const endDate = tokyoDate(now);
  const startDate = `${shiftMonth(endDate.slice(0, 7), -(months - 1))}-01`;
  return { startDate, endDate, months };
}

function unavailableKind(kind: UtilityKind, reason: string, genres: UtilityKindView["genres"] = []): UtilityKindView {
  return { ...summarizeUtilityKind(kind, genres, []), unavailable: reason };
}

const BASE_NOTES = [
  "date はZaimに登録された請求・支払の日で、検針期間（対象期間）ではない。月ごとの集計（monthly）はこの日付の月で束ねている。",
  "Zaim公式APIから読むため、手入力・API登録（請求メールからAsset Manager経由で取り込んだもの）の明細だけが対象で、カード等の自動連携明細は含まれない。",
  "使用量（usage）は品名に書かれているときだけ入る。書かれていない月は null で、推測値ではない。",
];

export interface BuildUtilityBillsOptions {
  kinds?: readonly UtilityKind[];
  months?: number;
  now?: Date;
  /** テスト用の差し替え。 */
  credentials?: ZaimOAuthCredentials | null;
  readMaster?: (credentials: ZaimOAuthCredentials) => Promise<{ master: ZaimMaster | null; reason: string | null }>;
  fetchPayments?: typeof fetchZaimPayments;
}

async function defaultReadMaster(credentials: ZaimOAuthCredentials) {
  const outcome = await readZaimMaster(credentials);
  return { master: outcome.master, reason: outcome.ok ? null : outcome.reason };
}

/**
 * 電気代・ガス代を読む。**失敗しても例外を投げない**（種類ごとに `unavailable` へ理由を入れる）。
 */
export async function buildUtilityBills(options: BuildUtilityBillsOptions = {}): Promise<UtilityBillsView> {
  const kinds = options.kinds ?? UTILITY_KINDS;
  const period = utilityPeriod(options.now ?? new Date(), options.months ?? DEFAULT_MONTHS);
  const credentials = options.credentials === undefined ? loadZaimOAuthCredentials() : options.credentials;

  if (!credentials) {
    return {
      configured: false,
      period,
      kinds: kinds.map((kind) => unavailableKind(kind, "Zaim APIの認証情報が設定されていない")),
      note: "AIDE_ZAIM_* が設定されていないため、電気代・ガス代を取得できない。請求が無いという意味ではない。",
    };
  }

  const { master, reason } = await (options.readMaster ?? defaultReadMaster)(credentials);
  if (!master) {
    return {
      configured: true,
      period,
      kinds: kinds.map((kind) => unavailableKind(kind, `Zaimのジャンル一覧を取得できなかった: ${reason ?? "不明"}`)),
      note: BASE_NOTES.join(" "),
    };
  }

  const fetchPayments = options.fetchPayments ?? fetchZaimPayments;
  const views = await Promise.all(
    kinds.map(async (kind): Promise<UtilityKindView> => {
      const genres = findUtilityGenres(master, kind);
      if (genres.length === 0) {
        return unavailableKind(kind, `Zaimに「${KIND_LABELS[kind]}」を含むジャンルが見つからない`);
      }
      const outcomes = await Promise.all(
        genres.map((genre) =>
          fetchPayments(credentials, { genreId: genre.id, startDate: period.startDate, endDate: period.endDate }),
        ),
      );
      const failed = outcomes.find((outcome) => !outcome.ok);
      if (failed && !failed.ok) return unavailableKind(kind, failed.reason, genres);

      const payments = outcomes.flatMap((outcome) => (outcome.ok ? outcome.payments : []));
      const truncated = outcomes.some((outcome) => outcome.ok && outcome.truncated);
      return summarizeUtilityKind(kind, genres, payments, truncated);
    }),
  );

  return { configured: true, period, kinds: views, note: BASE_NOTES.join(" ") };
}
