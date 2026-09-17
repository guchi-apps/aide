import { fetchZaimMoneyList } from "../../core/connectors/zaim/index.ts";
import type { ZaimMoneyEntry, ZaimMoneyList } from "../../core/connectors/zaim/types.ts";
import { publish } from "../sink.ts";

/** Zaim家計簿明細キャッシュのキー。参照側（ビュー）と共有する。 */
export const ZAIM_MONEY_CACHE_KEY = "zaim-money-snapshot";

/** 当月（JST）を `YYYYMM` で返す。 */
export function currentZaimMonth(now: Date): string {
  const [year, month] = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
  })
    .format(now)
    .split("-");
  return `${year}${month}`;
}

/** 先月（JST）を `YYYYMM` で返す。 */
export function previousZaimMonth(now: Date): string {
  const month = currentZaimMonth(now);
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(4, 6));
  const prevYear = m === 1 ? year - 1 : year;
  const prevMonth = m === 1 ? 12 : m - 1;
  return `${prevYear}${String(prevMonth).padStart(2, "0")}`;
}

/**
 * 複数月ぶんの取得結果を1つにまとめる。**純粋関数。**
 *
 * 同じ明細idが複数の結果に跨って出た場合（月境界のずれ等）は、先に渡した結果を優先して残す。
 * `id` が null の明細（編集リンクを読めなかった行）は重複判定できないため、そのまま残す。
 */
export function mergeZaimMoneyLists(lists: readonly ZaimMoneyList[]): ZaimMoneyList {
  const months: string[] = [];
  const seenIds = new Set<number>();
  const entries: ZaimMoneyEntry[] = [];
  for (const list of lists) {
    months.push(...list.months);
    for (const entry of list.entries) {
      if (entry.id !== null) {
        if (seenIds.has(entry.id)) continue;
        seenIds.add(entry.id);
      }
      entries.push(entry);
    }
  }
  return { entries, months };
}

/**
 * Zaim Web版の家計簿明細一覧（当月＋先月ぶん、JST）を巡回してキャッシュを更新する。
 *
 * 公式API（`GET /v2/home/money`）が返さない自動連携明細（スマートレシート等）も、
 * この経路なら公式APIと同じように取得できる（aide#244）。ヘッドレスChromiumを起動するため
 * 重く、`zaim-sync` と同じくworkerから定期実行する。
 *
 * **先月分も読む理由**: asset-manager側（guchi-apps/asset-manager#443）が「反映待ち」明細の
 * 置き換え前候補をこの一覧から探すが、当月分だけでは月初に先月のカード連携明細が候補から
 * 漏れる（aide#286）。
 *
 * 当月分の取得に失敗した場合はジョブ全体を失敗させる（従来どおり）。**先月分だけの取得に
 * 失敗した場合は当月分のみで保存する**（`months` も当月だけになる）。当月分の欠落のほうが
 * 実害が大きいと判断したため。
 */
export async function runZaimMoneySync(): Promise<string> {
  const now = new Date();
  const month = currentZaimMonth(now);
  const prevMonth = previousZaimMonth(now);

  const current = await fetchZaimMoneyList(month);

  const lists = [current];
  let previousFailureMessage: string | null = null;
  try {
    lists.unshift(await fetchZaimMoneyList(prevMonth));
  } catch (cause) {
    previousFailureMessage = cause instanceof Error ? cause.message : String(cause);
  }

  const merged = mergeZaimMoneyLists(lists);
  const destination = await publish(ZAIM_MONEY_CACHE_KEY, "zaim-money", merged);

  const parts = [
    `${merged.months.join("・")}分の明細 ${merged.entries.length} 件を取得し、${destination}`,
  ];
  if (previousFailureMessage) {
    parts.push(`（${prevMonth}分の取得に失敗したため当月のみ: ${previousFailureMessage}）`);
  }
  return parts.join("");
}
