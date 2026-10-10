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

/**
 * money-list.mjs が一覧の1行から拾う生テキスト（aide#244）。
 *
 * Zaim Web版の家計簿一覧（`/money?month=YYYYMM`）は、公式API（`GET /v2/home/money`）が
 * 返さない自動連携明細（スマートレシート等）もそのまま表示する。この画面を読むことで、
 * その明細も取得できる。
 */
export interface ZaimRawMoneyEntry {
  /** 明細の編集リンク（例: `/money/10228209053/edit`）。IDはここから取り出す。 */
  editUrl: string;
  /** 表示のまま（例: `"9月2日（水）"`）。年は month パラメータ側で補う。`isoDate` があればそちらを使う。 */
  date: string;
  /**
   * `YYYY-MM-DD`。明細JSON（`/money/details`）から読んだ場合の日付（aide#481）。
   * Zaimの「月」は暦月ではなく年をまたぐこともあるため、month から年を補うより確実。
   */
  isoDate?: string;
  /** 「￥1,238」のような表示のまま。 */
  amount: string;
  category: string;
  genre: string;
  /** 出金元の口座名（一覧のアイコンの alt テキスト）。 */
  account: string;
  /** 振替の場合の振込先口座名。通常は空。 */
  toAccount: string;
  place: string;
  /**
   * 品目名。**1件の明細に複数品目がある場合、一覧には先頭の1件しか出ず、
   * 末尾が「…」で省略されることがある。** 正確な全品目が要る場合は
   * 一覧だけでは読めない（Zaimの編集画面を個別に開く必要がある）。
   */
  name: string;
  comment: string;
  /**
   * 子明細を持つ取引の商品内訳（`scripts/receipt-detail.mjs`。#596）。
   * 旧スクリプトの出力には無いため省略可能で、無ければ `none` として扱う。
   */
  detail?: ZaimRawReceiptDetail;
}

/** 取引の編集画面から読んだ商品1行。値引き・配送料・税金も1行として入る。 */
export interface ZaimRawReceiptItem {
  /** Zaimの子明細id（親の1行は取引のidと同じ）。 */
  id: number | null;
  name: string;
  amount: number;
  quantity: null;
  unitPrice: null;
  discount: null;
  tax: null;
  category: string;
  genre: string;
}

/**
 * 商品内訳の取得状態。
 *
 * - `none`     … 子明細を持たない通常明細（内訳は無い）
 * - `complete` … 件数も合計も一致した（完全取得）
 * - `partial`  … 商品行は読めたが件数か合計が合わない
 * - `failed`   … 取得・解析に失敗した（items は付けない）
 */
export type ZaimItemsStatus = "none" | "complete" | "partial" | "failed";

export interface ZaimRawReceiptDetail {
  status: ZaimItemsStatus;
  items?: ZaimRawReceiptItem[];
  reason?: string;
}

export interface ZaimRawMoneyListResult {
  url: string;
  /** クロール対象の年月（`YYYYMM`）。表示テキストの日付に年を足すために使う。 */
  month: string;
  entries: ZaimRawMoneyEntry[];
}

/** 家計簿明細1件。金額を数値化し、明細IDを編集リンクから取り出した結果。 */
export interface ZaimMoneyEntry {
  /** Zaimの明細ID。編集リンクから取れなければ null。 */
  id: number | null;
  /** `YYYY-MM-DD`。 */
  date: string;
  amount: number;
  category: string;
  genre: string;
  account: string;
  toAccount: string;
  place: string;
  /** `ZaimRawMoneyEntry.name` を参照（省略されうる）。 */
  name: string;
  comment: string;
  /**
   * 商品別の内訳（スマートレシート・Amazon・カード連携の複数品目）。**`complete` と `partial` の
   * ときだけ付く。** 取得できなかった行・内訳を持たない行にはキー自体を作らない
   * （asset-managerが「未取得」と「空」を区別するため）。`name` が代表の1品でも、
   * ここへ取引合計を載せた行は作らない。
   */
  items?: ZaimMoneyItem[];
  /**
   * 内訳の取得状態。**`complete` だけが完全取得。** `partial`（一部）・`failed`（失敗）の
   * 行は、利用側が商品明細として確定してはいけない。旧キャッシュには無い。
   */
  itemsStatus?: ZaimItemsStatus;
  /** `partial` / `failed` の理由。 */
  itemsNote?: string;
}

/** `GET /api/money/transactions` の `entries[].items` の1行（asset-managerの `LinkedDetailItem` に対応）。 */
export interface ZaimMoneyItem {
  /** Zaimの子明細id。元取引との対応を追えるように保持する（asset-manager側は使わない）。 */
  id: number | null;
  name: string;
  /** 値引き適用後の金額。値引き・割引の行は負の数になる。 */
  amount: number;
  /** Zaimの画面に専用項目が無いため、数量・単価・値引き額・税額は常に null（推測しない）。 */
  quantity: number | null;
  unitPrice: number | null;
  discount: number | null;
  tax: number | null;
  category: string;
  genre: string;
}

export interface ZaimMoneyList {
  entries: ZaimMoneyEntry[];
  /**
   * 明細を漏れなく読めた**暦月**（`YYYYMM`）。asset-managerが「AIDEが読めた範囲」の判定に使う。
   * 取得結果1件では、取得に使った**Zaimの月**（開始日区切り。暦月とは限らない）が入る。
   * 暦月へ直すのは `zaim-month.ts` の `coveredCalendarMonths`。
   */
  months: string[];
}
