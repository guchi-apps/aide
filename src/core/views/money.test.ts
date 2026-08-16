import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { summarizeFixedCosts } from "./money.ts";
import { tokyoDate } from "../connectors/subscriptions/index.ts";
import type { Subscription, SubscriptionsSnapshot } from "../connectors/subscriptions/types.ts";

/**
 * `summarizeFixedCosts` は純粋関数なので、テストはここに集中させる。
 * 月額換算・次回支払日そのものは subscription-lists 側の計算結果で、こちらの責務ではない。
 */

const REFERENCE_DATE = "2026-08-16";

function subscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: "sub-1",
    name: "Netflix",
    contractStatus: "AUTO_RENEWING",
    currentPrice: { amount: 1490, currency: "JPY", billingCycle: "MONTHLY", billingInterval: 1 },
    monthlyAmount: 1490,
    monthlyAmountJpy: 1490,
    nextPayment: { date: "2026-09-05", amount: 1490, currency: "JPY" },
    ...overrides,
  };
}

function snapshot(overrides: Partial<SubscriptionsSnapshot> = {}): SubscriptionsSnapshot {
  return {
    referenceDate: REFERENCE_DATE,
    usdJpyRate: 152.3,
    totals: { monthlyByCurrency: { JPY: 1490 }, monthlyJpy: 1490 },
    subscriptions: [subscription()],
    ...overrides,
  };
}

describe("summarizeFixedCosts", () => {
  it("月額合計・明細・支払予定を返す", () => {
    const view = summarizeFixedCosts(snapshot());

    assert.equal(view.configured, true);
    assert.equal(view.unavailable, null);
    assert.equal(view.count, 1);
    assert.deepEqual(view.monthlyByCurrency, [{ currency: "JPY", amount: 1490 }]);
    assert.deepEqual(view.items, [
      { name: "Netflix", monthlyAmount: 1490, currency: "JPY", nextPaymentDate: "2026-09-05" },
    ]);
    assert.deepEqual(view.upcoming, [
      { name: "Netflix", date: "2026-09-05", amount: 1490, currency: "JPY" },
    ]);
  });

  it("通貨をまたいで合算せず、混在していることを note に断る", () => {
    const view = summarizeFixedCosts(
      snapshot({
        totals: { monthlyByCurrency: { JPY: 1490, USD: 25.98 }, monthlyJpy: 5447 },
        subscriptions: [
          subscription(),
          subscription({
            id: "sub-2",
            name: "GitHub Copilot",
            currentPrice: {
              amount: 100,
              currency: "USD",
              billingCycle: "YEARLY",
              billingInterval: 1,
            },
            monthlyAmount: 8.33,
            monthlyAmountJpy: 1269,
            nextPayment: { date: "2026-12-01", amount: 100, currency: "USD" },
          }),
        ],
      }),
    );

    assert.deepEqual(view.monthlyByCurrency, [
      { currency: "JPY", amount: 1490 },
      { currency: "USD", amount: 25.98 },
    ]);
    assert.equal(view.monthlyJpy, 5447);
    assert.match(view.note, /加算しないこと/);
    assert.match(view.note, /参考値/);
  });

  it("為替レートが取れていなければ円換算を出さず、その旨を note に残す", () => {
    const view = summarizeFixedCosts(
      snapshot({
        usdJpyRate: null,
        totals: { monthlyByCurrency: { USD: 25.98 }, monthlyJpy: null },
        subscriptions: [
          subscription({
            currentPrice: {
              amount: 25.98,
              currency: "USD",
              billingCycle: "MONTHLY",
              billingInterval: 1,
            },
            monthlyAmount: 25.98,
            monthlyAmountJpy: null,
          }),
        ],
      }),
    );

    assert.equal(view.monthlyJpy, null);
    assert.equal(view.usdJpyRate, null);
    assert.match(view.note, /為替レートを取得できなかった/);
  });

  it("支払予定は31日以内だけを日付の昇順で返す", () => {
    const view = summarizeFixedCosts(
      snapshot({
        subscriptions: [
          subscription({ id: "a", name: "31日後（含む）", nextPayment: { date: "2026-09-16", amount: 100, currency: "JPY" } }),
          subscription({ id: "b", name: "32日後（含まない）", nextPayment: { date: "2026-09-17", amount: 200, currency: "JPY" } }),
          subscription({ id: "c", name: "当日（含む）", nextPayment: { date: REFERENCE_DATE, amount: 300, currency: "JPY" } }),
          subscription({ id: "d", name: "支払予定なし", nextPayment: null }),
        ],
      }),
    );

    assert.deepEqual(
      view.upcoming.map((payment) => payment.name),
      ["当日（含む）", "31日後（含む）"],
    );
    // 明細のほうは期間で絞らない。「何にいくら払っているか」に答えるため。
    assert.equal(view.count, 4);
    assert.equal(view.items.at(-1)?.nextPaymentDate, null);
  });

  it("契約が1件も無くても configured のまま空で返す", () => {
    const view = summarizeFixedCosts(
      snapshot({ totals: { monthlyByCurrency: {}, monthlyJpy: 0 }, subscriptions: [] }),
    );

    assert.equal(view.configured, true);
    assert.equal(view.count, 0);
    assert.deepEqual(view.monthlyByCurrency, []);
    assert.deepEqual(view.upcoming, []);
  });
});

describe("tokyoDate", () => {
  it("UTCで前日になる時刻でも日本時間の日付を返す", () => {
    // UTC 2026-08-15 23:00 は JST 2026-08-16 08:00。
    assert.equal(tokyoDate(new Date("2026-08-15T23:00:00.000Z")), "2026-08-16");
    assert.equal(tokyoDate(new Date("2026-08-16T14:59:00.000Z")), "2026-08-16");
    assert.equal(tokyoDate(new Date("2026-08-16T15:00:00.000Z")), "2026-08-17");
  });
});
