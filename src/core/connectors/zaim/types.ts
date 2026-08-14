/** 巡回スクリプトが出力する生テキスト。金額は「￥1,234」のような表示のまま。 */
export interface ZaimRawEntry {
  name: string;
  amount: string;
}

export interface ZaimRawSecuritiesPage {
  url: string;
  account: string;
  holdings: ZaimRawEntry[];
}

export interface ZaimRawScrapeResult {
  url: string;
  balances: ZaimRawEntry[];
  securities: ZaimRawSecuritiesPage[];
}

export interface ZaimBalance {
  name: string;
  amount: number;
}

export interface ZaimHolding {
  /** 証券口座名。同じ銘柄を口座ごとに分けて対応付けるために保持する。 */
  account: string;
  name: string;
  amount: number;
  /**
   * 同一口座内に同名の銘柄が複数行ある場合の出現順（1始まり）。
   * Zaimは旧NISA・新NISA等の口座区分を表示しないため、行の順番でしか区別できない。
   */
  occurrence: number;
  /** 同一口座内にある同名の行数。1なら順番指定は不要。 */
  occurrenceCount: number;
}

export interface ZaimSnapshot {
  balances: ZaimBalance[];
  holdings: ZaimHolding[];
}
