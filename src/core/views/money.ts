import { readCache } from "../cache/store.ts";
import {
  describeFailure,
  fetchSubscriptions,
  readSubscriptionsConfig,
  tokyoDate,
} from "../connectors/subscriptions/index.ts";
import type {
  SubscriptionContractStatus,
  SubscriptionCurrency,
  SubscriptionsSnapshot,
} from "../connectors/subscriptions/types.ts";
import { findStaleZaimAccounts } from "../connectors/zaim/parse.ts";
import type { ZaimOnlineAccount, ZaimSnapshot } from "../connectors/zaim/types.ts";
import { ZAIM_CACHE_KEY } from "../../worker/jobs/zaim-sync.ts";

/** これを超えたら鮮度が怪しいとみなす。巡回は日次想定。動作状況ページ（`/status`）も同じ基準で判定する。 */
export const STALE_AFTER_MINUTES = 60 * 24;

/** 「次の支払予定」として返す期間。1ヶ月ぶんの支払を必ず1周ぶん含められる長さにしてある。 */
const UPCOMING_DAYS = 31;

export interface FixedCostTotal {
  currency: SubscriptionCurrency;
  amount: number;
}

/** 支払方法ごとの月額合計。**通貨別に分ける**ため、支払方法1件につき通貨のぶんだけ行が出る。 */
export interface FixedCostPaymentMethodTotal {
  /** 支払方法の名称（例 `"楽天カード"`）。 */
  paymentMethod: string;
  currency: SubscriptionCurrency;
  amount: number;
}

export interface FixedCostItem {
  name: string;
  /** 月額換算。年払い等も月あたりへ均してある。 */
  monthlyAmount: number;
  currency: SubscriptionCurrency;
  /**
   * 契約状況。`SCHEDULED_TO_END` は解約予定（期限まで使えるが自動更新しない）。
   * 解約済み（`ENDED`）は既定でAPIから返らないため、実質2値になる。
   */
  contractStatus: SubscriptionContractStatus;
  /** 引き落とし元（例 `"楽天カード"`）。 */
  paymentMethod: string;
  /** 次回の支払日（`YYYY-MM-DD`）。見つからなければ null。 */
  nextPaymentDate: string | null;
}

export interface UpcomingPayment {
  name: string;
  date: string;
  amount: number;
  currency: SubscriptionCurrency;
}

/**
 * 月額固定費（サブスクリプション）。
 *
 * **残高・保有銘柄とは性質が違う。** あちらは「いま持っている額」（ストック）で、
 * こちらは「毎月出ていく額」（フロー）。同じ合計に混ぜると意味が壊れるため、
 * `MoneySummary.totals` には入れず、この器に分けている。
 */
export interface FixedCostsView {
  /** subscription-lists への接続が設定されているか。false なら以下はすべて空。 */
  configured: boolean;
  /** 月額合計。**通貨別。通貨をまたいで加算しない。** */
  monthlyByCurrency: FixedCostTotal[];
  /**
   * 支払方法別の月額合計。**通貨別に分けてあり、通貨をまたいで加算しない。**
   * 並びは通貨ごとにまとめたうえで金額の大きい順（同額なら支払方法名の昇順）。
   */
  monthlyByPaymentMethod: FixedCostPaymentMethodTotal[];
  /** 円換算した月額合計の参考値。換算できないものがあれば null。 */
  monthlyJpy: number | null;
  /** 円換算に使ったレート。取得できていなければ null。 */
  usdJpyRate: number | null;
  /** 集計対象の契約数。 */
  count: number;
  items: FixedCostItem[];
  /** 基準日から31日以内の支払予定。日付の昇順。 */
  upcoming: UpcomingPayment[];
  /** 取得できなかった理由。取得できていれば null。 */
  unavailable: { source: string; reason: string } | null;
  note: string;
}

export interface MoneySummary {
  /** キャッシュが空（まだ一度も巡回していない）なら true。**固定費とは無関係。** */
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
  /**
   * 連携口座とZaim側の「最終更新」。**`fetchedAt`（AIDEが巡回した時刻）とは別物。**
   * Zaimは更新ボタンを押すまで各金融機関から再取得しないため、巡回が新しくても
   * 中身が何日も前のことがある。
   */
  onlineAccounts: ZaimOnlineAccount[];
  /**
   * そのうち最終更新が当日（JST）でないもの。**当日の資産額として記録するかどうかは
   * 呼び出し側が決める**（AIDEは取得した事実だけを持つ）。
   */
  staleAccounts: ZaimOnlineAccount[];
  /** 月額固定費。ストックである残高とは別建てで返す。 */
  fixedCosts: FixedCostsView;
  note: string;
}

const sum = (items: { amount: number }[]): number =>
  items.reduce((total, item) => total + item.amount, 0);

/** 取得できなかったときの空の中身。呼び出しごとに別の配列を返す。 */
const emptyFixedCosts = (): Omit<FixedCostsView, "configured" | "unavailable" | "note"> => ({
  monthlyByCurrency: [],
  monthlyByPaymentMethod: [],
  monthlyJpy: null,
  usdJpyRate: null,
  count: 0,
  items: [],
  upcoming: [],
});

/** subscription-lists への接続が設定されていないときの答え。 */
function fixedCostsNotConfigured(): FixedCostsView {
  return {
    ...emptyFixedCosts(),
    configured: false,
    unavailable: { source: "subscription-lists", reason: "接続が設定されていない" },
    note:
      "AIDE_SUBSCRIPTIONS_TOKEN が設定されていないため、月額固定費を取得できない。" +
      "固定費が無いという意味ではない。",
  };
}

/** 設定はされているが取得できなかったときの答え。 */
function fixedCostsUnavailable(reason: string): FixedCostsView {
  return {
    ...emptyFixedCosts(),
    configured: true,
    unavailable: { source: "subscription-lists", reason },
    note:
      "月額固定費を取得できなかったため、以下の残高・保有銘柄だけで判断すること。" +
      "固定費が無いという意味ではない。",
  };
}

/** 通知やnoteに口座名を並べるときの上限。全部並べるとnoteが読めなくなる。 */
const LISTED_STALE_ACCOUNTS_MAX = 5;

/**
 * 連携口座の鮮度を畳む。**純粋関数。**
 *
 * 「当日でない口座がある」ことは伝えるが、その残高を使うか捨てるかは決めない。
 * 評価は asset-manager 側のドメインロジックにあたる（README「asset-manager との境界」）。
 */
export function summarizeAccountFreshness(
  onlineAccounts: readonly ZaimOnlineAccount[],
  now: Date,
): { staleAccounts: ZaimOnlineAccount[]; note: string | null } {
  if (onlineAccounts.length === 0) {
    // 古いキャッシュ（この項目を持たない巡回結果）でもここへ来る。
    return {
      staleAccounts: [],
      note: "連携口座の最終更新は取得できていないため、balances・holdings の lastUpdatedAt はすべて null になっている。",
    };
  }

  const staleAccounts = findStaleZaimAccounts(onlineAccounts, now);
  if (staleAccounts.length === 0) return { staleAccounts, note: null };

  const listed = staleAccounts.slice(0, LISTED_STALE_ACCOUNTS_MAX).map((account) => account.name);
  if (staleAccounts.length > listed.length) {
    listed.push(`ほか${staleAccounts.length - listed.length}件`);
  }
  return {
    staleAccounts,
    note:
      `Zaim側の最終更新が当日でない連携口座が ${staleAccounts.length} 件ある（${listed.join("・")}）。` +
      "これらの残高は当日の値ではないため、当日の資産額として記録するかは呼び出し側で判断すること。",
  };
}

/**
 * 浮動小数の誤差を落とす。`25.98 + 0` の類で `25.980000000000004` になるのを避けるだけで、
 * 丸めそのものが目的ではない（月額は小数2桁より細かくならない）。
 */
const roundAmount = (amount: number): number => Math.round(amount * 100) / 100;

/**
 * 支払方法別の月額合計。**通貨をまたいで加算しない**ため、支払方法と通貨の組で束ねる。
 *
 * 相手（subscription-lists）の `totals` にはこの内訳が無いので、ここで明細から積み上げる。
 * 並びは通貨ごとにまとめたうえで金額の大きい順。**通貨をまたいで大小を比べない**ため、
 * 額の小さいUSDが下へ流れて「少ない」ように見えることを避けている。
 */
function summarizeByPaymentMethod(
  subscriptions: SubscriptionsSnapshot["subscriptions"],
): FixedCostPaymentMethodTotal[] {
  const totals = new Map<string, FixedCostPaymentMethodTotal>();
  for (const subscription of subscriptions) {
    const currency = subscription.currentPrice.currency;
    const key = `${subscription.paymentMethod}\u0000${currency}`;
    const found = totals.get(key);
    if (found) {
      found.amount += subscription.monthlyAmount;
    } else {
      totals.set(key, {
        paymentMethod: subscription.paymentMethod,
        currency,
        amount: subscription.monthlyAmount,
      });
    }
  }

  return [...totals.values()]
    .map((total) => ({ ...total, amount: roundAmount(total.amount) }))
    .sort(
      (a, b) =>
        a.currency.localeCompare(b.currency) ||
        b.amount - a.amount ||
        a.paymentMethod.localeCompare(b.paymentMethod),
    );
}

/** `YYYY-MM-DD` に日数を足す。ISO形式なので文字列のまま大小比較できる。 */
function addDays(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/**
 * 取得結果を横断ビューの粒度へ畳む。**純粋関数。テストはここに集中する。**
 *
 * 月額換算・次回支払日は subscription-lists が計算済みで返すため、ここでは計算し直さない
 * （向こうの `billing.ts` にある月末クランプ・料金改定の切り替えを再実装すると必ずズレる）。
 */
export function summarizeFixedCosts(snapshot: SubscriptionsSnapshot): FixedCostsView {
  const items: FixedCostItem[] = snapshot.subscriptions.map((subscription) => ({
    name: subscription.name,
    monthlyAmount: subscription.monthlyAmount,
    currency: subscription.currentPrice.currency,
    contractStatus: subscription.contractStatus,
    paymentMethod: subscription.paymentMethod,
    nextPaymentDate: subscription.nextPayment?.date ?? null,
  }));

  const until = addDays(snapshot.referenceDate, UPCOMING_DAYS);
  const upcoming: UpcomingPayment[] = snapshot.subscriptions
    .flatMap((subscription) => {
      const payment = subscription.nextPayment;
      // 基準日より前の支払日は返らない想定だが、返ってきても「予定」には含めない。
      if (!payment || payment.date < snapshot.referenceDate || payment.date > until) return [];
      return [{ name: subscription.name, ...payment }];
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  const monthlyByCurrency: FixedCostTotal[] = Object.entries(snapshot.totals.monthlyByCurrency)
    .filter((entry): entry is [SubscriptionCurrency, number] => typeof entry[1] === "number")
    .map(([currency, amount]) => ({ currency, amount }));

  const monthlyByPaymentMethod = summarizeByPaymentMethod(snapshot.subscriptions);

  const notes = [
    `${snapshot.referenceDate} 時点の月額固定費。年払い等も月あたりへ均してある。`,
    "残高・保有銘柄（ストック）とは性質が違うため、totals には足していない。",
  ];
  if (monthlyByCurrency.length > 1) {
    notes.push("通貨別に分けてある。為替が絡むため、通貨をまたいで加算しないこと。");
  }
  if (items.length > 0) {
    notes.push(
      "items の contractStatus が SCHEDULED_TO_END のものは解約予定。解約済み（ENDED）は取得対象から外れているため、ここには現れない。",
    );
    notes.push(
      "monthlyByPaymentMethod は明細から積み上げた支払方法別の月額で、通貨別に分けてある。",
    );
  }
  if (snapshot.totals.monthlyJpy !== null) {
    notes.push("monthlyJpy は日次更新のレートによる概算で、参考値にすぎない。");
  } else if (monthlyByCurrency.some((total) => total.currency !== "JPY")) {
    notes.push("為替レートを取得できなかったため、円換算値は出せていない。");
  }

  return {
    configured: true,
    monthlyByCurrency,
    monthlyByPaymentMethod,
    monthlyJpy: snapshot.totals.monthlyJpy,
    usdJpyRate: snapshot.usdJpyRate,
    count: items.length,
    items,
    upcoming,
    unavailable: null,
    note: notes.join(" "),
  };
}

/**
 * 固定費を取得して畳む。**失敗しても例外を投げない。**
 *
 * subscription-lists が落ちていても残高・保有銘柄は返せるため、
 * ここで throw すると答えられたはずの問いまで答えられなくなる。
 */
async function loadFixedCosts(now: Date): Promise<FixedCostsView> {
  const config = readSubscriptionsConfig();
  if (!config) return fixedCostsNotConfigured();

  try {
    // 基準日は日本時間で渡す。VPSのTZはUTCで、渡さないと 00:00〜09:00 が前日基準になる。
    return summarizeFixedCosts(await fetchSubscriptions(config, tokyoDate(now)));
  } catch (cause) {
    return fixedCostsUnavailable(describeFailure(cause));
  }
}

/**
 * お金まわりの横断ビュー。
 *
 * 情報源は Zaim（残高・保有銘柄）と subscription-lists（月額固定費）。
 * 将来 meisai-lab（給与）を足す場所もここになる。
 *
 * **Zaimの巡回結果はキャッシュを読むだけで、取得は行わない**（Playwrightで十数秒かかるため）。
 * 固定費は同じVPS上へのHTTP GETで数ミリ秒のため、都度取得する。README「どこまでを『重い取得』
 * とみなすか」の判断に従っている。
 */
export async function buildMoneySummary(now: Date = new Date()): Promise<MoneySummary> {
  // 固定費の取得（数ミリ秒・失敗しても投げない）とキャッシュの読み出しは互いに独立。
  const [cached, fixedCosts] = await Promise.all([
    readCache<ZaimSnapshot>(ZAIM_CACHE_KEY),
    loadFixedCosts(now),
  ]);

  if (!cached) {
    return {
      empty: true,
      fetchedAt: null,
      ageMinutes: null,
      stale: true,
      totals: null,
      balances: [],
      holdings: [],
      onlineAccounts: [],
      staleAccounts: [],
      fixedCosts,
      note: "残高・保有銘柄はまだ一度も取得していない。worker の zaim-sync ジョブを実行する必要がある。",
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

  // この項目を持たない時期のキャッシュが残っていることがある（キャッシュはデプロイをまたぐ）。
  const onlineAccounts = cached.data.onlineAccounts ?? [];
  const freshness = summarizeAccountFreshness(onlineAccounts, now);
  if (freshness.note) notes.push(freshness.note);

  return {
    empty: false,
    fetchedAt: cached.fetchedAt,
    ageMinutes: cached.ageMinutes,
    stale,
    totals: { balances: sum(cached.data.balances), holdings: sum(cached.data.holdings) },
    balances: cached.data.balances,
    holdings: cached.data.holdings,
    onlineAccounts,
    staleAccounts: freshness.staleAccounts,
    fixedCosts,
    note: notes.join(" "),
  };
}
