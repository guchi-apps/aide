import { scrapeZaimSnapshot } from "../../core/connectors/zaim/index.ts";
import { findStaleZaimAccounts } from "../../core/connectors/zaim/parse.ts";
import { notifyStaleAccounts } from "../notify.ts";
import { publish } from "../sink.ts";
import type { JobName } from "./catalog.ts";

/** Zaimキャッシュのキー。参照側（ビュー・MCPツール）と共有する。 */
export const ZAIM_CACHE_KEY = "zaim-snapshot";

/** ジョブ名。通知の記録キーに使うため、カタログの名前とズレないよう型で縛る。 */
const JOB_NAME: JobName = "zaim-sync";

/**
 * 口座の更新漏れを判定してよい巡回か（JSTの時刻で見る）。
 *
 * 判定は「最終更新が当日（JST）か」で見るため（`findStaleZaimAccounts`）、**その日のうちに
 * もう一度更新される機会が残っている巡回では、正常な口座まで必ず「当日でない」側に入る。**
 * 1日2回になった時点（#165）で、11:35 の巡回は前夜に更新できた口座を
 * 「更新できなかった」と判定し、23:35 の巡回で解消する——という警告と復旧の往復を毎日生む。
 *
 * **これは通知の抑制では塞げない。** 全口座が当日になった時点で `notifyStaleAccounts` は
 * 記録ごと消すため、次に古い口座が出た巡回は抑制の窓に関係なく無条件で通知される。
 *
 * そこで判定は**その日の最後の巡回でだけ**行う。時刻で見ているのは、ジョブ側からタイマーの
 * 設定を読めないため。20時は `deploy/systemd/aide-zaim-sync.timer` の 23:35 だけを拾い、
 * 昼の 11:35 を外せる境目として置いている（タイマーの時刻を変えるならここも見直す）。
 *
 * **判定を押下側（`zaim-refresh`）ではなくここに置いている**のは、押した直後には反映が遅い
 * 口座（SBI証券など・約35分）がまだ進んでおらず、遅いだけの口座を毎晩「更新できなかった」と
 * 警告してしまうため（#178）。巡回の時点なら反映は済んでいる。
 */
export function isFinalSyncOfDay(now: Date): boolean {
  const hour = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    hour12: false,
  }).format(now);
  return Number(hour) >= 20;
}

/**
 * Zaimを巡回してキャッシュを更新する。
 *
 * ヘッドレスChromiumを起動し証券詳細ページを巡回するため十数秒かかる。
 * 資産評価額は1日2回で足りるので、毎時回す必要はない（#165）。
 * セッション維持は zaim-keep-alive ジョブが別に担う。
 *
 * 書き出し先はローカルかリモートかを sink が判断する。本番では worker がサブPC、
 * サーバーがVPSで別マシンのため、HTTPで送る。
 */
export async function runZaimSync(): Promise<string> {
  const snapshot = await scrapeZaimSnapshot();
  const destination = await publish(ZAIM_CACHE_KEY, "zaim", snapshot);

  const parts = [
    `残高 ${snapshot.balances.length} 件 / 保有銘柄 ${snapshot.holdings.length} 件を取得し、${destination}`,
  ];

  const now = new Date();
  if (isFinalSyncOfDay(now)) {
    // 「当日（JST）に更新されていない口座」を一部失敗とみなす。更新ボタンを押しても
    // 進まなかった口座だけでなく、ゆうちょ銀行のように何ヶ月も前で止まっている口座も含む。
    const stale = findStaleZaimAccounts(snapshot.onlineAccounts, now);
    await notifyStaleAccounts(JOB_NAME, stale);
    if (stale.length > 0) parts.push(`（当日になっていない口座 ${stale.length} 件）`);
  } else {
    // 判定しなかったことを記録に残す。「警告が出ていない」と「判定していない」は別。
    parts.push("（更新漏れの判定はその日の最後の巡回で行う）");
  }

  return parts.join("");
}
