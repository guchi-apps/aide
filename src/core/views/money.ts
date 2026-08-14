import { readCache } from "../cache/store.ts";
import type { ZaimSnapshot } from "../connectors/zaim/types.ts";
import { ZAIM_CACHE_KEY } from "../../worker/jobs/zaim-sync.ts";

/** これを超えたら鮮度が怪しいとみなす。巡回は日次想定。 */
const STALE_AFTER_MINUTES = 60 * 24;

export interface MoneySummary {
  /** キャッシュが空（まだ一度も巡回していない）なら true。 */
  empty: boolean;
  fetchedAt: string | null;
  ageMinutes: number | null;
  stale: boolean;
  /**
   * 残高と保有銘柄の合計は**足してはいけない**。
   * Zaimの残高一覧には証券口座の合計が含まれ、保有銘柄はその内訳にあたるため、
   * 単純に加算すると証券分を二重に数える。
   */
  totals: { balances: number; holdings: number } | null;
  balances: ZaimSnapshot["balances"];
  holdings: ZaimSnapshot["holdings"];
  note: string;
}

const sum = (items: { amount: number }[]): number =>
  items.reduce((total, item) => total + item.amount, 0);

/**
 * お金まわりの横断ビュー。
 *
 * 現時点の情報源はZaimのみ。将来 meisai-lab（給与）や subscription-lists を
 * 足す場所がここになる。**キャッシュを読むだけで、取得は行わない。**
 */
export async function buildMoneySummary(): Promise<MoneySummary> {
  const cached = await readCache<ZaimSnapshot>(ZAIM_CACHE_KEY);

  if (!cached) {
    return {
      empty: true,
      fetchedAt: null,
      ageMinutes: null,
      stale: true,
      totals: null,
      balances: [],
      holdings: [],
      note: "まだ一度も取得していない。worker の zaim-sync ジョブを実行する必要がある。",
    };
  }

  const stale = cached.ageMinutes > STALE_AFTER_MINUTES;
  const notes = [
    "balances（残高一覧）には証券口座の合計が含まれ、holdings（保有銘柄）はその内訳にあたる。両者を足すと証券分を二重に数えるため、合算しないこと。",
  ];
  if (stale) {
    notes.push(
      `このデータは ${Math.round(cached.ageMinutes / 60)} 時間前のもので、現在の残高とは異なる可能性がある。`,
    );
  }

  return {
    empty: false,
    fetchedAt: cached.fetchedAt,
    ageMinutes: cached.ageMinutes,
    stale,
    totals: { balances: sum(cached.data.balances), holdings: sum(cached.data.holdings) },
    balances: cached.data.balances,
    holdings: cached.data.holdings,
    note: notes.join(" "),
  };
}
