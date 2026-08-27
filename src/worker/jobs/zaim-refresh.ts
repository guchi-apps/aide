import { refreshZaimOnlineAccounts } from "../../core/connectors/zaim/refresh.ts";

/**
 * Zaimの連携口座を一括更新する。
 *
 * Zaimは「データを更新する」を押すまで各金融機関から再取得しないため、押さないまま
 * 巡回すると、その日の資産額として古い残高が記録される（#62）。**このジョブは押して
 * 完了を待つだけで、取得はしない。** 巡回は65分後に置いた `zaim-sync` が行う。
 *
 * 更新できない口座（連携先のAPIキーの権限エラー、金融機関側のログイン期限切れ）が
 * あってもジョブは成功扱いにする。押下自体は成功しており、失敗として扱うと
 * 「AIDE側で直せる問題」に見えてしまうため。
 *
 * **更新漏れの判定はここでは行わない。** 押した直後に読める「最終更新」は、反映が遅い
 * 口座（SBI証券など・約35分）をまだ含んでいない。判定は反映後に走る `zaim-sync` に置く
 * （#178。理由は `jobs/zaim-sync.ts` の `isFinalSyncOfDay`）。
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
    "）",
  ];

  return parts.join("");
}
