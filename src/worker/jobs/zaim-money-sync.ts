import { fetchZaimMoneyList } from "../../core/connectors/zaim/index.ts";
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

/**
 * Zaim Web版の家計簿明細一覧（当月ぶん）を巡回してキャッシュを更新する。
 *
 * 公式API（`GET /v2/home/money`）が返さない自動連携明細（スマートレシート等）も、
 * この経路なら公式APIと同じように取得できる（aide#244）。ヘッドレスChromiumを起動するため
 * 重く、`zaim-sync` と同じくworkerから定期実行する。
 */
export async function runZaimMoneySync(): Promise<string> {
  const month = currentZaimMonth(new Date());
  const list = await fetchZaimMoneyList(month);
  const destination = await publish(ZAIM_MONEY_CACHE_KEY, "zaim-money", list);
  return `${month}分の明細 ${list.entries.length} 件を取得し、${destination}`;
}
