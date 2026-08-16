/**
 * subscription-lists の `GET /api/internal/subscriptions` のレスポンスのうち、
 * **AIDEが使うフィールドだけ**を再宣言する。
 *
 * 相手の仕様は subscription-lists の `docs/internal-api.md` が正本。
 * 全部を写すと向こうの変更のたびに追従が要るため、使う範囲に絞っている。
 */

/** 相手の `enum Currency`。混在を許すため、合算してはいけない。 */
export type SubscriptionCurrency = "JPY" | "USD";

/** 契約状況。`ENDED`（解約済み）は既定でAPIから除外されて返らない。 */
export type SubscriptionContractStatus = "AUTO_RENEWING" | "SCHEDULED_TO_END" | "ENDED";

/** 現在適用中の料金改定。月額換算の根拠として併記されている生の値。 */
export interface SubscriptionPrice {
  amount: number;
  currency: SubscriptionCurrency;
  billingCycle: "MONTHLY" | "YEARLY";
  /** 何ヶ月／何年ごとか。 */
  billingInterval: number;
}

export interface SubscriptionPayment {
  /** `YYYY-MM-DD`。 */
  date: string;
  amount: number;
  currency: SubscriptionCurrency;
}

export interface Subscription {
  id: string;
  name: string;
  contractStatus: SubscriptionContractStatus;
  currentPrice: SubscriptionPrice;
  /** `currentPrice` の通貨のままの月額換算。 */
  monthlyAmount: number;
  /** 円換算した参考値。USD建てでレートが取れなければ null。 */
  monthlyAmountJpy: number | null;
  /** 3年先まで探して見つからなければ null（解約済み等）。 */
  nextPayment: SubscriptionPayment | null;
}

export interface SubscriptionsSnapshot {
  /** 相手が計算に使った基準日（`YYYY-MM-DD`）。AIDEが渡した値がそのまま返る。 */
  referenceDate: string;
  /** 取得できなければ null。 */
  usdJpyRate: number | null;
  totals: {
    /** 通貨別の月額合計。**通貨をまたいで加算しない。** */
    monthlyByCurrency: Partial<Record<SubscriptionCurrency, number>>;
    /** 円換算した参考値。円換算できないものが1件でもあれば null。 */
    monthlyJpy: number | null;
  };
  subscriptions: Subscription[];
}
