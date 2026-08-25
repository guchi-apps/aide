import { findStaleZaimAccounts } from "../../core/connectors/zaim/parse.ts";
import { refreshZaimOnlineAccounts } from "../../core/connectors/zaim/refresh.ts";
import { notifyStaleAccounts } from "../notify.ts";
import type { JobName } from "./catalog.ts";

/** ジョブ名。通知の記録キーに使うため、カタログの名前とズレないよう型で縛る。 */
const JOB_NAME: JobName = "zaim-refresh";

/**
 * 口座の更新漏れを判定してよい実行か（JSTの時刻で見る）。
 *
 * 判定は「最終更新が当日（JST）か」で見るため（`findStaleZaimAccounts`）、**その日のうちに
 * もう一度押す機会が残っている実行では、正常な口座まで必ず「当日でない」側に入る。**
 * 1日2回に増やした時点（#165）で、11:15 の実行は前夜23:2xに更新できた口座を
 * 「更新できなかった」と判定し、23:15 の実行で解消する——という警告と復旧の往復を毎日生む。
 *
 * **これは通知の抑制では塞げない。** 全口座が当日になった時点で `notifyStaleAccounts` は
 * 記録ごと消すため、次に古い口座が出た実行は抑制の窓に関係なく無条件で通知される。
 *
 * そこで判定は**その日の最後の押下でだけ**行う。時刻で見ているのは、ジョブ側からタイマーの
 * 設定を読めないため。20時は `deploy/systemd/aide-zaim-refresh.timer` の 23:15 だけを拾い、
 * 昼の 11:15 を外せる境目として置いている（タイマーの時刻を変えるならここも見直す）。
 */
export function isFinalRefreshOfDay(now: Date): boolean {
  const hour = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    hour12: false,
  }).format(now);
  return Number(hour) >= 20;
}

/**
 * Zaimの連携口座を一括更新する。
 *
 * Zaimは「データを更新する」を押すまで各金融機関から再取得しないため、押さないまま
 * 巡回すると、その日の資産額として古い残高が記録される（#62）。**このジョブは押して
 * 完了を待つだけで、取得はしない。** 巡回は少し後ろに置いた `zaim-sync` が行う。
 *
 * 更新できない口座（連携先のAPIキーの権限エラー、金融機関側のログイン期限切れ）が
 * あってもジョブは成功扱いにする。押下自体は成功しており、失敗として扱うと
 * 「AIDE側で直せる問題」に見えてしまうため。代わりに一部失敗として通知する。
 */
export async function runZaimRefresh(): Promise<string> {
  const result = await refreshZaimOnlineAccounts();

  if (result.accounts.length === 0) {
    // 押せてはいるが、完了したかを確認できていない。Zaim側の画面構成が変わって
    // 「最終更新」を拾えなくなった可能性が高いので、失敗として通知に載せる。
    throw new Error(
      "Zaimの連携口座と最終更新を1件も読み取れませんでした（画面構成が変わった可能性があります）",
    );
  }

  const advanced = result.accounts.filter((account) => account.advanced).length;
  const waitedMinutes = Math.round(result.waitedMs / 60_000);
  const parts = [
    `連携口座 ${result.accounts.length} 件のうち ${advanced} 件が更新された`,
    `（${waitedMinutes}分待ち`,
    result.timedOut ? "・待ち時間の上限で打ち切り" : "",
  ];

  const now = new Date();
  if (isFinalRefreshOfDay(now)) {
    // 「当日（JST）に更新されていない口座」を一部失敗とみなす。押した直後に最終更新が
    // 進まなかった口座だけでなく、ゆうちょ銀行のように何ヶ月も前で止まっている口座も含む。
    const stale = findStaleZaimAccounts(result.accounts, now);
    await notifyStaleAccounts(JOB_NAME, stale);
    if (stale.length > 0) parts.push(`・当日になっていない口座 ${stale.length} 件`);
  } else {
    // 判定しなかったことを記録に残す。「警告が出ていない」と「判定していない」は別。
    parts.push("・更新漏れの判定はその日の最後の押下で行う");
  }

  parts.push("）");
  return parts.join("");
}
