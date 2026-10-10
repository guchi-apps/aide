/**
 * `receipt-detail.mjs` の型。`allowJs` を有効にしていないため、`.ts` からimportするときは
 * この宣言だけが型情報になる。`.mjs` へ関数を足したらここにも宣言を足すこと。
 */

export interface ZaimRawReceiptItem {
  /** Zaimの子明細id（親の1行は取引のidと同じ）。 */
  id: number | null;
  name: string;
  /** 値引き・配送料などは独立した行として入る（値引きは負の数）。 */
  amount: number;
  /** Zaimの画面に専用項目が無いため常に null。 */
  quantity: null;
  unitPrice: null;
  discount: null;
  tax: null;
  /** カテゴリ名・内訳名。マスタから引けなければ空文字。 */
  category: string;
  genre: string;
}

export type ZaimReceiptDetailStatus = "none" | "complete" | "partial" | "failed";

export interface ZaimRawReceiptDetail {
  status: ZaimReceiptDetailStatus;
  /** `complete` と `partial` のときだけ付く。 */
  items?: ZaimRawReceiptItem[];
  /** `partial` と `failed` の理由。 */
  reason?: string;
}

export function extractJsonAssignment(html: string, name: string): unknown;

export function extractGenreNames(html: string): Map<number, { genre: string; category: string }>;

export function buildReceiptDetail(
  entry: { id: number; isoDate: string; amount: number; childCount: number },
  page: { ok: boolean; status?: number; html?: string } | null,
): ZaimRawReceiptDetail;
