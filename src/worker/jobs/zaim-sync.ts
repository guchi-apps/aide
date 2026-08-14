import { scrapeZaimSnapshot } from "../../core/connectors/zaim/index.ts";
import { publish } from "../sink.ts";

/** Zaimキャッシュのキー。参照側（ビュー・MCPツール）と共有する。 */
export const ZAIM_CACHE_KEY = "zaim-snapshot";

/**
 * Zaimを巡回してキャッシュを更新する。
 *
 * ヘッドレスChromiumを起動し証券詳細ページを巡回するため十数秒かかる。
 * 資産評価額は日次で足りるので、毎時回す必要はない。
 * セッション維持は zaim-keep-alive ジョブが別に担う。
 *
 * 書き出し先はローカルかリモートかを sink が判断する。本番では worker がサブPC、
 * サーバーがVPSで別マシンのため、HTTPで送る。
 */
export async function runZaimSync(): Promise<string> {
  const snapshot = await scrapeZaimSnapshot();
  const destination = await publish(ZAIM_CACHE_KEY, "zaim", snapshot);
  return `残高 ${snapshot.balances.length} 件 / 保有銘柄 ${snapshot.holdings.length} 件を取得し、${destination}`;
}
