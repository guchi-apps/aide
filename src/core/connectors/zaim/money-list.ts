import {
  isZaimAutoReloginFailed,
  isZaimSessionExpired,
  zaimSessionExpiredMessage,
} from "./errors.ts";
import { buildZaimMoneyList } from "./parse.ts";
import { type ZaimScriptDeps, runZaimScript, zaimScriptPath } from "./session.ts";
import type { ZaimMoneyList, ZaimRawMoneyListResult } from "./types.ts";

const MONEY_LIST_TIMEOUT_MS = 60_000;

const MONEY_LIST_SCRIPT = zaimScriptPath("money-list.mjs");

/**
 * Zaim Web版の家計簿明細一覧を、指定した月ぶん取得する（aide#244）。
 *
 * **公式API（`GET /v2/home/money`）は自動連携が作った明細を返さない**（`write.ts` 参照。
 * guchi-apps/asset-manager#379 で実測）。この経路はPlaywrightでWeb版の一覧画面をそのまま読むため、
 * スマートレシート等の自動連携明細も公式APIと同じように取得できる。
 *
 * Playwrightでヘッドレスブラウザを起動するため重い。MCPやAPIの同期リクエストから
 * 直接呼んではいけない。worker から定期実行し、結果をキャッシュに書いて、参照側はキャッシュを読む。
 *
 * **1件の明細に複数品目がある場合、`name` には一覧に出る先頭の品目名しか入らない。**
 * Zaim Web版の一覧表示自体が省略するため（`parse.ts` の `ZaimRawMoneyEntry.name` を参照）。
 */
export async function fetchZaimMoneyList(month: string, deps?: ZaimScriptDeps): Promise<ZaimMoneyList> {
  try {
    const stdout = await runZaimScript(
      MONEY_LIST_SCRIPT,
      { timeout: MONEY_LIST_TIMEOUT_MS, env: { ZAIM_MONEY_MONTH: month } },
      deps,
    );

    const result = JSON.parse(stdout) as ZaimRawMoneyListResult;
    if (!Array.isArray(result.entries)) {
      throw new Error("Zaim明細一覧スクリプトの応答が不正です");
    }
    return buildZaimMoneyList(result);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (isZaimSessionExpired(message)) {
      throw new Error(zaimSessionExpiredMessage(isZaimAutoReloginFailed(message)));
    }
    throw cause;
  }
}
