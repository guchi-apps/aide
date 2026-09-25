import { fetchZaimMoneyList } from "../../core/connectors/zaim/index.ts";
import type { ZaimMoneyEntry, ZaimMoneyList } from "../../core/connectors/zaim/types.ts";
import {
  coveredCalendarMonths,
  zaimMonthStartDay,
  zaimMonthsToRead,
} from "../../core/connectors/zaim/zaim-month.ts";
import { publish } from "../sink.ts";

/** Zaim家計簿明細キャッシュのキー。参照側（ビュー）と共有する。 */
export const ZAIM_MONEY_CACHE_KEY = "zaim-money-snapshot";

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
 * Zaim Web版の家計簿明細（今日を含むZaimの月＋その前月、JST）を巡回してキャッシュを更新する。
 *
 * 公式API（`GET /v2/home/money`）が返さない自動連携明細（スマートレシート等）も、
 * この経路なら公式APIと同じように取得できる（aide#244）。ヘッドレスChromiumを起動するため
 * 重く、`zaim-sync` と同じくworkerから定期実行する。
 *
 * **読むのは「Zaimの月」で、暦月ではない**（aide#481）。開始日が25日なら `202609` は
 * 8/25〜9/24。暦月で作ると毎月25日〜月末の明細がどちらの月にも入らない。一方キャッシュの
 * `months` は**暦月のまま**で、全日を読めた暦月だけを入れる（asset-managerが暦月として
 * 「AIDEが読めた範囲」を判定しているため。`coveredCalendarMonths` 参照）。
 *
 * **前月分も読む理由**: asset-manager側（guchi-apps/asset-manager#443）が「反映待ち」明細の
 * 置き換え前候補をこの一覧から探すが、当月分だけでは月初に先月のカード連携明細が候補から
 * 漏れる（aide#286）。
 *
 * 今日を含む月の取得に失敗した場合はジョブ全体を失敗させる（従来どおり）。**前月分だけの取得に
 * 失敗した場合は今日を含む月のみで保存する**（`months` もその範囲で覆える暦月だけになる）。
 */
export async function runZaimMoneySync(): Promise<string> {
  const now = new Date();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(now);
  const startDay = zaimMonthStartDay();
  const [prevMonth, month] = zaimMonthsToRead(today, startDay) as [string, string];

  const current = await fetchZaimMoneyList(month);

  const lists = [current];
  let previousFailureMessage: string | null = null;
  try {
    lists.unshift(await fetchZaimMoneyList(prevMonth));
  } catch (cause) {
    previousFailureMessage = cause instanceof Error ? cause.message : String(cause);
  }

  const merged = mergeZaimMoneyLists(lists);
  const covered = coveredCalendarMonths(merged.months, today, startDay);
  const destination = await publish(ZAIM_MONEY_CACHE_KEY, "zaim-money", { ...merged, months: covered });

  const parts = [
    `Zaimの${merged.months.join("・")}月（暦月で${covered.join("・") || "なし"}が全日分）の明細 ${merged.entries.length} 件を取得し、${destination}`,
  ];
  if (previousFailureMessage) {
    parts.push(`（${prevMonth}分の取得に失敗したため今日を含む月のみ: ${previousFailureMessage}）`);
  }
  return parts.join("");
}
