import { readCache } from "../cache/store.ts";
import type { ZaimMoneyEntry, ZaimMoneyList } from "../connectors/zaim/index.ts";
import { ZAIM_MONEY_CACHE_KEY } from "../../worker/jobs/zaim-money-sync.ts";

/** これを超えたら鮮度が怪しいとみなす。`zaim-money-sync` と同じ間隔（1日2回）に合わせている。 */
export const STALE_AFTER_MINUTES = 60 * 18;

export interface MoneyTransactionsView {
  /** キャッシュが空（まだ一度も巡回していない）なら true。 */
  empty: boolean;
  fetchedAt: string | null;
  ageMinutes: number | null;
  stale: boolean;
  entries: ZaimMoneyEntry[];
  note: string;
}

const NAME_TRUNCATION_NOTE =
  "1件の明細に複数品目がある場合、name には一覧に表示される先頭の品目名しか入らず、" +
  "末尾が「…」で省略されていることがある（Zaim Web版の一覧表示自体の仕様）。" +
  "正確な全品目が必要な場合は、この一覧だけでは読めない。";

/**
 * Zaim Web版の家計簿明細一覧の横断ビュー。
 *
 * **公式API（`GET /v2/home/money`）が返さない自動連携明細（スマートレシート等）も含む**
 * （aide#244。`src/core/connectors/zaim/write.ts` 参照）。
 *
 * `src/core/views/money.ts`（残高・保有銘柄・固定費）とは情報源も粒度も別物のため分けている。
 *
 * **巡回結果はキャッシュを読むだけで、取得は行わない**（Playwrightで数十秒かかるため。
 * README「取得と提供の分離」）。
 */
export async function buildMoneyTransactions(): Promise<MoneyTransactionsView> {
  const cached = await readCache<ZaimMoneyList>(ZAIM_MONEY_CACHE_KEY);
  if (!cached) {
    return {
      empty: true,
      fetchedAt: null,
      ageMinutes: null,
      stale: true,
      entries: [],
      note: "まだ一度も取得していない。worker の zaim-money-sync ジョブを実行する必要がある。",
    };
  }

  const stale = cached.ageMinutes > STALE_AFTER_MINUTES;
  const notes = [NAME_TRUNCATION_NOTE];
  if (stale) {
    notes.push(
      `このデータは ${Math.round(cached.ageMinutes / 60)} 時間前のもので、当月の最新明細を反映していない可能性がある。`,
    );
  }

  return {
    empty: false,
    fetchedAt: cached.fetchedAt,
    ageMinutes: cached.ageMinutes,
    stale,
    entries: cached.data.entries,
    note: notes.join(" "),
  };
}
