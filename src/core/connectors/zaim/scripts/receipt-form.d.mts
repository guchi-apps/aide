/**
 * `receipt-form.mjs` の型。
 *
 * 実装を `.mjs` に置いているのは `online-accounts.mjs` と同じ理由で、抽出関数を
 * Playwrightがブラウザへ文字列として渡すため。DOMの当て方はこのコネクタでもっとも
 * 壊れやすい箇所なので、判断だけを切り出してテストから呼べるようにしている。
 */

export interface ZaimYearMonth {
  year: number;
  month: number;
}

export interface ZaimMenuItem {
  /** カテゴリの見出し行なら true。ジャンルの行なら false。 */
  header: boolean;
  label: string;
  /** 絞り込みの結果として画面に出ているか。隠れている候補も配列には残る。 */
  visible: boolean;
}

export declare function resolveReceiptUrl(): string;

export declare function parseMonthHeader(text: string | null | undefined): ZaimYearMonth | null;

export declare function monthsBetween(from: ZaimYearMonth, to: ZaimYearMonth): number;

export declare function splitDate(date: string): { year: number; month: number; day: number };

export declare function dateMatches(value: string | null | undefined, date: string): boolean;

export declare function pickGenreIndex(
  items: readonly ZaimMenuItem[],
  categoryName: string,
  genreName: string,
): number;

export declare function composeComment(
  comment: string | undefined,
  requestId: string,
  maxLength: number,
): { text: string } | { error: string };

export declare function amountDigits(amount: number): string;

export declare function parseAmountValue(value: string | null | undefined): number | null;

/** ページ内で実行される。表示中の候補を見出し／ジャンルに畳む。 */
export declare function readMenuItems(items: unknown[]): ZaimMenuItem[];
