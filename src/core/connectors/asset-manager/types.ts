/**
 * Asset Manager の `GET /api/subscriptions` のレスポンスのうち、
 * **AIDEが横断ビュー（`aide_fixed_costs`）に使うフィールドだけ**を再宣言する。
 *
 * 相手の仕様は asset-manager の `docs/subscriptions.md` が正本。全部を写すと向こうの変更のたびに
 * 追従が要るため、使う範囲に絞っている。MCPの `asset_manager_subscriptions` は応答をそのまま返す
 * ので、こちらの型には縛られない。
 */

/** 通貨。混在を許すため、合算してはいけない。 */
export type SubscriptionCurrency = "JPY" | "USD";

/** 契約状況。`ENDED`（解約済み）は既定でAPIから除外されて返らない。 */
export type SubscriptionContractStatus = "AUTO_RENEWING" | "SCHEDULED_TO_END" | "ENDED";

export interface AssetManagerSubscription {
  id: number;
  name: string;
  /**
   * 区分。現状は `SUBSCRIPTION`（サブスク）・`INSURANCE`（保険・共済）・`TAX`（税金・年次支出）・
   * `INSTALLMENT`（分割払い）・`OTHER_FIXED_COST`（その他固定費）。相手が増やしても壊れないよう
   * 文字列のまま受ける。
   */
  category: string;
  /** 区分の表示名（例 `"保険・共済"`）。 */
  categoryLabel: string;
  status: SubscriptionContractStatus;
  /** 支払方法の名称（例 `"三井住友カード(VISA)"`）。 */
  paymentMethod: string;
  /** 1回あたりの請求額。`monthlyAmount`（月あたり）とは別物。 */
  amount: number;
  currency: SubscriptionCurrency;
  /** `currency` のままの月額換算。 */
  monthlyAmount: number;
  /** 円換算した参考値。USD建てでレートが取れなければ null。 */
  monthlyAmountJpy: number | null;
  /** 次回の請求日（`YYYY-MM-DD`）。更新されない契約（終了日未入力で自動更新もしない解約予定）は null。 */
  nextBillingDay: string | null;
}

export interface AssetManagerSubscriptionsSnapshot {
  status: "ok";
  /** 相手が計算に使った基準日（`YYYY-MM-DD`）。 */
  asOf: string;
  summary: {
    /**
     * **全区分**（保険・税金・分割払いを含む）の月額合計（円）。`monthlyTotalJpy` は
     * サブスク区分だけの集計なので、固定費にはこちらを使う。円換算できない契約は含まれない。
     */
    fixedCostMonthlyTotalJpy: number;
    /** 取得できなければ null。 */
    usdJpyRate: number | null;
    /** 円換算できず合計に含めていない契約の名前。空なら合計は全件ぶん。 */
    excludedFromTotal: string[];
  };
  subscriptions: AssetManagerSubscription[];
}
