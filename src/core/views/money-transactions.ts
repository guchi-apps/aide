import { readCache } from "../cache/store.ts";
import type { ZaimFailedMonth, ZaimMoneyEntry, ZaimMoneyList } from "../connectors/zaim/index.ts";
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
  /** 巡回で読もうとしたZaimの月（aide#760）。旧キャッシュでは省略する。 */
  requestedMonths?: string[];
  /** 読めなかったZaimの月と理由（aide#760）。空なら全部読めた。旧キャッシュでは省略する。 */
  failedMonths?: ZaimFailedMonth[];
  /** 明細JSONの1件が持っていた項目の名前（値は含まない。aide#759）。旧キャッシュでは省略する。 */
  sourceFields?: string[];
  /**
   * 期間指定（`?from=&to=`。aide#785）で呼ばれたときだけ付く。`entries` はこの範囲の日付だけで、
   * `months` もこの範囲に**月まるごと**入る月だけに絞ってある（範囲外の明細を「消えた」と誤判定させないため）。
   */
  range?: MoneyTransactionsRange;
  entries: MoneyTransactionEntry[];
  note: string;
}

/** 期間指定（両端を含む `YYYY-MM-DD`）。片側だけの指定は null。 */
export interface MoneyTransactionsRange {
  from: string | null;
  to: string | null;
}

/** 日付が期間に入るか（`YYYY-MM-DD` は文字列比較で順序が保たれる）。 */
function inRange(date: string, range: MoneyTransactionsRange): boolean {
  if (range.from !== null && date < range.from) return false;
  if (range.to !== null && date > range.to) return false;
  return true;
}

/**
 * 暦月（`YYYYMM`）が期間に**まるごと**入るか。
 *
 * `months` は asset-manager が「この月に無い明細は消えた」と判定する範囲なので、期間が月の途中で
 * 切れる月を残すと、範囲外で返さなかった明細を消えたと誤判定させる。途中で切れる月は落とす。
 */
function monthWithinRange(month: string, range: MoneyTransactionsRange): boolean {
  const year = Number(month.slice(0, 4));
  const mon = Number(month.slice(4, 6));
  if (!Number.isInteger(year) || !Number.isInteger(mon) || mon < 1 || mon > 12) return false;
  const first = `${month.slice(0, 4)}-${month.slice(4, 6)}-01`;
  const lastDay = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  const last = `${month.slice(0, 4)}-${month.slice(4, 6)}-${String(lastDay).padStart(2, "0")}`;
  return inRange(first, range) && inRange(last, range);
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
  "itemsFetchedAt が付く行は、定期巡回より後に手動再取得（POST /api/zaim/receipt-detail/refresh）した内訳に差し替えてある。" +
  "mode（payment / income / transfer）・fromAccountId・toAccountId・childIds・calcFlag（集計の設定の生の値）は、" +
  "Zaimの明細JSONに項目があったときだけ付く（項目名は sourceFields で確かめられる）。calcFlag の値の意味は未確定。";

/**
 * Zaim Web版の家計簿明細一覧の横断ビュー。
 *
 * **公式API（`GET /v2/home/money`）が返さない自動連携明細（スマートレシート等）も含む**
 * （aide#244）。
 *
 * `src/core/views/money.ts`（残高・保有銘柄・固定費）とは情報源も粒度も別物のため分けている。
 *
 * **巡回結果はキャッシュを読むだけで、取得は行わない**（Playwrightで数十秒かかるため。
 * README「取得と提供の分離」）。
 */
export async function buildMoneyTransactions(
  options: { range?: MoneyTransactionsRange } = {},
): Promise<MoneyTransactionsView> {
  const range = options.range;
  const cached = await readCache<ZaimMoneyList>(ZAIM_MONEY_CACHE_KEY);
  if (!cached) {
    return {
      empty: true,
      fetchedAt: null,
      ageMinutes: null,
      stale: true,
      ...(range ? { range } : {}),
      entries: [],
      note: "まだ一度も取得していない。worker の zaim-money-sync ジョブを実行する必要がある。",
    };
  }

  const stale = cached.ageMinutes > STALE_AFTER_MINUTES;
  const notes = [NAME_TRUNCATION_NOTE];
  if (cached.data.failedMonths && cached.data.failedMonths.length > 0) {
    notes.push(
      `Zaimの${cached.data.failedMonths.map((f) => f.month).join("・")}月は読めなかった（months に含まれない）。`,
    );
  }
  if (stale) {
    notes.push(
      `このデータは ${Math.round(cached.ageMinutes / 60)} 時間前のもので、最新の明細を反映していない可能性がある。`,
    );
  }

  if (range) {
    notes.push(
      "期間指定のため、entries は range の日付だけ、months は range に月まるごと入る月だけに絞ってある。",
    );
  }

  // 重ね合わせ（手動再取得のキャッシュ読み）の前に絞り、範囲外の取引のキャッシュを引かない。
  const entries = range ? cached.data.entries.filter((e) => inRange(e.date, range)) : cached.data.entries;
  const months = cached.data.months && range
    ? cached.data.months.filter((m) => monthWithinRange(m, range))
    : cached.data.months;

  return {
    empty: false,
    fetchedAt: cached.fetchedAt,
    ageMinutes: cached.ageMinutes,
    stale,
    ...(months ? { months } : {}),
    ...(cached.data.requestedMonths ? { requestedMonths: cached.data.requestedMonths } : {}),
    ...(cached.data.failedMonths ? { failedMonths: cached.data.failedMonths } : {}),
    ...(cached.data.sourceFields ? { sourceFields: cached.data.sourceFields } : {}),
    ...(range ? { range } : {}),
    entries: await overlayReceiptDetails(entries, cached.fetchedAt),
    note: notes.join(" "),
  };
}
