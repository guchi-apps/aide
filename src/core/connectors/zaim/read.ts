import { zaimRequest, type ZaimOAuthCredentials } from "./oauth.ts";
import { classifyFailure } from "./write.ts";

/**
 * Zaim公式APIで家計簿の支出を読む（aide#324）。
 *
 * **Web版の一覧（`money-list.ts`）とは読める範囲が違う。**
 *
 * - こちらはOAuthのHTTP GETで、期間を自由に指定できる。軽いので呼び出しのたびに叩いてよい
 *   （README「どこまでを『重い取得』とみなすか」）
 * - ただし**自動連携（銀行・カード・スマートレシート）の明細は返らない**（Zaim APIの仕様。
 *   `write.ts` 参照）。返るのは手入力とAPIで登録した明細だけ
 *
 * 電気・ガスの請求はGmailの請求メールからAsset Manager経由でAPI登録される（#199・#223）ため、
 * こちらで読める。Web版の一覧は当月＋先月ぶんしかキャッシュしておらず、推移を答えられない。
 */

/** 1ページの件数。Zaim APIの上限。 */
const PAGE_LIMIT = 100;

/**
 * 1ジャンルあたりに読むページ数の上限。電気・ガスの請求は月に1〜2件なので、
 * 3年ぶん（36か月）でも1ページに収まる。上限に達したら `truncated` で知らせる。
 */
const MAX_PAGES = 5;

export interface ZaimApiPayment {
  id: number;
  /** `YYYY-MM-DD`。 */
  date: string;
  amount: number;
  categoryId: number;
  genreId: number;
  name: string;
  place: string;
  comment: string;
}

export interface FetchZaimPaymentsQuery {
  genreId: number;
  /** `YYYY-MM-DD`（この日を含む）。 */
  startDate: string;
  /** `YYYY-MM-DD`（この日を含む）。 */
  endDate: string;
}

export type FetchZaimPaymentsOutcome =
  | { ok: true; payments: ZaimApiPayment[]; truncated: boolean }
  | { ok: false; reason: string };

/** テスト用の差し替え口。既定では本物のZaimを叩く。 */
export type ZaimRequester = (
  credentials: ZaimOAuthCredentials,
  method: "GET",
  path: string,
  params: Record<string, string>,
) => Promise<unknown>;

/**
 * 応答の1行を読む。**削除済み（`active: -1`）・支出以外・形の崩れた行は落とす。**
 */
export function parseZaimApiPayment(row: unknown): ZaimApiPayment | null {
  if (typeof row !== "object" || row === null) return null;
  const r = row as Record<string, unknown>;
  if (r["active"] === -1) return null;
  if (r["mode"] !== undefined && r["mode"] !== "payment") return null;

  const id = Number(r["id"]);
  const amount = Number(r["amount"]);
  const date = typeof r["date"] === "string" ? r["date"].slice(0, 10) : "";
  if (!Number.isInteger(id) || !Number.isFinite(amount) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  return {
    id,
    date,
    amount,
    categoryId: Number(r["category_id"] ?? 0),
    genreId: Number(r["genre_id"] ?? 0),
    name: typeof r["name"] === "string" ? r["name"] : "",
    place: typeof r["place"] === "string" ? r["place"] : "",
    comment: typeof r["comment"] === "string" ? r["comment"] : "",
  };
}

/**
 * 指定ジャンルの支出を期間で読む。**失敗しても例外を投げない。**
 */
export async function fetchZaimPayments(
  credentials: ZaimOAuthCredentials,
  query: FetchZaimPaymentsQuery,
  request: ZaimRequester = zaimRequest,
): Promise<FetchZaimPaymentsOutcome> {
  const payments: ZaimApiPayment[] = [];
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = await request(credentials, "GET", "/home/money", {
        mapping: "1",
        mode: "payment",
        genre_id: String(query.genreId),
        start_date: query.startDate,
        end_date: query.endDate,
        limit: String(PAGE_LIMIT),
        page: String(page),
      });
      const rows = (body as { money?: unknown }).money;
      if (!Array.isArray(rows)) return { ok: false, reason: "Zaimの応答に明細の一覧がありませんでした" };

      for (const row of rows) {
        const payment = parseZaimApiPayment(row);
        // genre_id で絞って頼んでいるが、念のため手元でも確かめる。
        if (payment && payment.genreId === query.genreId) payments.push(payment);
      }
      if (rows.length < PAGE_LIMIT) return { ok: true, payments, truncated: false };
    }
    return { ok: true, payments, truncated: true };
  } catch (cause) {
    return { ok: false, reason: classifyFailure(cause).reason };
  }
}
