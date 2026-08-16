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

/**
 * 連携口座一覧（`/online_accounts`）から拾った生テキスト。
 * `lastUpdatedAt` は「最終更新：2026年08月16日 14:27:38」のような表示のまま。
 */
export interface ZaimRawOnlineAccount {
  name: string;
  lastUpdatedAt: string;
}

export interface ZaimRawScrapeResult {
  url: string;
  balances: ZaimRawEntry[];
  securities: ZaimRawSecuritiesPage[];
  /** 連携口座の最終更新。取得できなかった場合は空配列（巡回自体は失敗させない）。 */
  onlineAccounts?: ZaimRawOnlineAccount[];
}

/**
 * Zaimの連携口座と、Zaim側が各金融機関から取得した「最終更新」日時。
 *
 * **これは「AIDEが巡回した時刻」ではない。** Zaimの連携口座は更新ボタンを押すまで
 * 再取得されないため、巡回が成功していても中身は何日も前の残高でありうる。
 * 当日の値として扱ってよいかを参照側（asset-manager）が判断できるように持たせている。
 */
export interface ZaimOnlineAccount {
  name: string;
  /** ISO8601（JSTオフセット付き）。表示から読めなければ null。 */
  lastUpdatedAt: string | null;
}

export interface ZaimBalance {
  name: string;
  amount: number;
  /**
   * この口座のZaim側「最終更新」。連携口座でない（現金・手入力）場合と、
   * 連携口座一覧の名称と突き合わせられなかった場合は null。
   */
  lastUpdatedAt: string | null;
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
  /** この証券口座のZaim側「最終更新」。突き合わせられなければ null。 */
  lastUpdatedAt: string | null;
}

export interface ZaimSnapshot {
  balances: ZaimBalance[];
  holdings: ZaimHolding[];
  /**
   * 連携口座の最終更新。**巡回時点でZaimに載っていた事実だけを持つ。**
   * 当日でないものを記録するかどうかの判断は参照側に委ねる。
   */
  onlineAccounts: ZaimOnlineAccount[];
}

/** 更新スクリプトが出力する生テキスト。日時は表示のまま。 */
export interface ZaimRawRefreshAccount {
  name: string;
  lastUpdatedAt: string;
  previousLastUpdatedAt: string | null;
  advanced: boolean;
}

export interface ZaimRawRefreshResult {
  pressed: boolean;
  accounts: ZaimRawRefreshAccount[];
  waitedMs: number;
  timedOut: boolean;
}

/** 更新ボタンを押した結果。口座ごとに最終更新が進んだかを持つ。 */
export interface ZaimRefreshAccount extends ZaimOnlineAccount {
  /** 押す前の最終更新。押す前に一覧へ現れなかった口座は null。 */
  previousLastUpdatedAt: string | null;
  /** 押した後に最終更新が進んだか。 */
  advanced: boolean;
}

export interface ZaimRefreshResult {
  /** 更新ボタンを押したか。dry-run では false。 */
  pressed: boolean;
  accounts: ZaimRefreshAccount[];
  /** 押してから完了待ちを打ち切るまでの待ち時間（ミリ秒）。 */
  waitedMs: number;
  /** 最大待ち時間まで待っても全口座が当日にならなかったか。 */
  timedOut: boolean;
}
