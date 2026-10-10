import { readCache } from "../cache/store.ts";
import type { ZaimMoneyEntry, ZaimMoneyList } from "../connectors/zaim/index.ts";
import {
  type ZaimReceiptDetailEntry,
  zaimReceiptDetailCacheKey,
} from "../connectors/zaim/receipt-refresh.ts";
import { ZAIM_MONEY_CACHE_KEY } from "../../worker/jobs/zaim-money-sync.ts";

/** これを超えたら鮮度が怪しいとみなす。`zaim-money-sync` と同じ間隔（1日2回）に合わせている。 */
export const STALE_AFTER_MINUTES = 60 * 18;

export interface MoneyTransactionsView {
  /** キャッシュが空（まだ一度も巡回していない）なら true。 */
  empty: boolean;
  fetchedAt: string | null;
  ageMinutes: number | null;
  stale: boolean;
  /**
   * 実際に読んだ月（`YYYYMM`の配列）。デプロイ直後、`months`を持たない旧キャッシュを読んだ
   * 場合は省略する（asset-manager側は、無ければ`fetchedAt`の月だけを読んだものとして扱う）。
   */
  months?: string[];
  entries: MoneyTransactionEntry[];
  note: string;
}

/**
 * `ZaimMoneyEntry` に、商品内訳を**手動再取得した時刻**を足したもの。
 * 付くのは、定期巡回より新しい手動再取得の結果を重ねた行だけ（#600）。
 */
export type MoneyTransactionEntry = ZaimMoneyEntry & { itemsFetchedAt?: string };

/** 手動再取得の結果をキャッシュへ置くときの形（`worker/receipt-refresh-jobs.ts`）。 */
interface ReceiptDetailOverride {
  entry: ZaimReceiptDetailEntry;
  fetchedAt: string;
}

/**
 * 定期巡回の一覧へ、より新しい手動再取得の商品内訳を重ねる。
 *
 * 重ねるのは、**同じ取引（id・日付・金額が一致）で、巡回より後に取得した内訳**だけ。
 * 巡回がその後に走れば巡回のほうが新しくなり、自然に重ならなくなる。
 */
async function overlayReceiptDetails(
  entries: ZaimMoneyEntry[],
  snapshotFetchedAt: string,
): Promise<MoneyTransactionEntry[]> {
  const snapshotTime = Date.parse(snapshotFetchedAt);
  return Promise.all(
    entries.map(async (entry): Promise<MoneyTransactionEntry> => {
      // 内訳を持つ（持とうとした）取引だけを見る。通常の明細にキャッシュを引きに行かない。
      if (entry.id === null || entry.itemsStatus === undefined || entry.itemsStatus === "none") return entry;
      let override: Awaited<ReturnType<typeof readCache<ReceiptDetailOverride>>>;
      try {
        override = await readCache<ReceiptDetailOverride>(zaimReceiptDetailCacheKey(entry.id));
      } catch {
        return entry;
      }
      const detail = override?.data;
      if (
        !detail ||
        detail.entry.id !== entry.id ||
        detail.entry.date !== entry.date ||
        detail.entry.amount !== entry.amount ||
        !(Date.parse(detail.fetchedAt) > snapshotTime)
      ) {
        return entry;
      }
      // 巡回の行から内訳の項目だけを入れ替える（`failed` の行には `items` を付けない契約のため、一度外す）。
      const { items: _items, itemsStatus: _status, itemsNote: _note, ...rest } = entry;
      return {
        ...rest,
        ...(detail.entry.items ? { items: detail.entry.items } : {}),
        ...(detail.entry.itemsStatus ? { itemsStatus: detail.entry.itemsStatus } : {}),
        ...(detail.entry.itemsNote ? { itemsNote: detail.entry.itemsNote } : {}),
        itemsFetchedAt: detail.fetchedAt,
      };
    }),
  );
}

const NAME_TRUNCATION_NOTE =
  "1件の明細に複数品目がある場合、name には一覧に表示される先頭の品目名しか入らず、" +
  "末尾が「…」で省略されていることがある（Zaim Web版の一覧表示自体の仕様）。" +
  "全品目は items に入る。items が付くのは itemsStatus が complete（件数・合計とも一致）または " +
  "partial（一部しか読めていない可能性。合計が合わない）の行だけで、failed（取得失敗）の行と" +
  "内訳を持たない通常明細には付かない。complete 以外は商品明細として確定しないこと。" +
  "itemsStatus が無い行は、内訳の取得に対応する前のキャッシュで、次の巡回で更新される。" +
  "itemsFetchedAt が付く行は、定期巡回より後に手動再取得（POST /api/zaim/receipt-detail/refresh）した内訳に差し替えてある。";

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
      `このデータは ${Math.round(cached.ageMinutes / 60)} 時間前のもので、最新の明細を反映していない可能性がある。`,
    );
  }

  return {
    empty: false,
    fetchedAt: cached.fetchedAt,
    ageMinutes: cached.ageMinutes,
    stale,
    ...(cached.data.months ? { months: cached.data.months } : {}),
    entries: await overlayReceiptDetails(cached.data.entries, cached.fetchedAt),
    note: notes.join(" "),
  };
}
