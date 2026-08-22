import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { summarizeAccountFreshness, summarizeFixedCosts } from "./money.ts";
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
    paymentMethod: "楽天カード",
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
      {
        name: "Netflix",
        monthlyAmount: 1490,
        currency: "JPY",
        contractStatus: "AUTO_RENEWING",
        paymentMethod: "楽天カード",
        nextPaymentDate: "2026-09-05",
      },
    ]);
    assert.deepEqual(view.monthlyByPaymentMethod, [
      { paymentMethod: "楽天カード", currency: "JPY", amount: 1490 },
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
    assert.deepEqual(view.monthlyByPaymentMethod, []);
    assert.deepEqual(view.upcoming, []);
  });

  it("契約状況と支払方法を明細へそのまま通す", () => {
    const view = summarizeFixedCosts(
      snapshot({
        totals: { monthlyByCurrency: { JPY: 2470 }, monthlyJpy: 2470 },
        subscriptions: [
          subscription(),
          subscription({
            id: "sub-2",
            name: "解約予定のサービス",
            paymentMethod: "三菱UFJ銀行",
            contractStatus: "SCHEDULED_TO_END",
            currentPrice: {
              amount: 980,
              currency: "JPY",
              billingCycle: "MONTHLY",
              billingInterval: 1,
            },
            monthlyAmount: 980,
            monthlyAmountJpy: 980,
          }),
        ],
      }),
    );

    assert.deepEqual(
      view.items.map((item) => [item.name, item.contractStatus, item.paymentMethod]),
      [
        ["Netflix", "AUTO_RENEWING", "楽天カード"],
        ["解約予定のサービス", "SCHEDULED_TO_END", "三菱UFJ銀行"],
      ],
    );
    // 解約済みが既定で返らないことは、読み手が誤解しないよう note で断る。
    assert.match(view.note, /SCHEDULED_TO_END/);
    assert.match(view.note, /ENDED/);
  });

  it("支払方法別の月額を通貨ごとに金額の大きい順でまとめる", () => {
    const view = summarizeFixedCosts(
      snapshot({
        totals: { monthlyByCurrency: { JPY: 3450 }, monthlyJpy: 3450 },
        subscriptions: [
          subscription(),
          subscription({
            id: "sub-2",
            name: "Spotify",
            paymentMethod: "楽天カード",
            currentPrice: {
              amount: 980,
              currency: "JPY",
              billingCycle: "MONTHLY",
              billingInterval: 1,
            },
            monthlyAmount: 980,
            monthlyAmountJpy: 980,
          }),
          subscription({
            id: "sub-3",
            name: "電気",
            paymentMethod: "三菱UFJ銀行",
            currentPrice: {
              amount: 980,
              currency: "JPY",
              billingCycle: "MONTHLY",
              billingInterval: 1,
            },
            monthlyAmount: 980,
            monthlyAmountJpy: 980,
          }),
        ],
      }),
    );

    assert.deepEqual(view.monthlyByPaymentMethod, [
      { paymentMethod: "楽天カード", currency: "JPY", amount: 2470 },
      { paymentMethod: "三菱UFJ銀行", currency: "JPY", amount: 980 },
    ]);
  });

  it("同じ支払方法でも通貨をまたいで加算しない", () => {
    const view = summarizeFixedCosts(
      snapshot({
        totals: { monthlyByCurrency: { JPY: 1490, USD: 25.98 }, monthlyJpy: 5447 },
        subscriptions: [
          subscription(),
          subscription({
            id: "sub-2",
            name: "GitHub Copilot",
            currentPrice: {
              amount: 12.99,
              currency: "USD",
              billingCycle: "MONTHLY",
              billingInterval: 1,
            },
            monthlyAmount: 12.99,
            monthlyAmountJpy: 1978,
          }),
          subscription({
            id: "sub-3",
            name: "ChatGPT Plus",
            currentPrice: {
              amount: 12.99,
              currency: "USD",
              billingCycle: "MONTHLY",
              billingInterval: 1,
            },
            monthlyAmount: 12.99,
            monthlyAmountJpy: 1978,
          }),
        ],
      }),
    );

    // 同じ「楽天カード」でも JPY と USD は別の行になる。合算すると意味が壊れるため。
    assert.deepEqual(view.monthlyByPaymentMethod, [
      { paymentMethod: "楽天カード", currency: "JPY", amount: 1490 },
      { paymentMethod: "楽天カード", currency: "USD", amount: 25.98 },
    ]);
  });
});

describe("summarizeAccountFreshness", () => {
  // UTC 2026-08-16 14:40 は JST 2026-08-16 23:40（巡回が終わる時刻）。
  const now = new Date("2026-08-16T14:40:00.000Z");

  it("全口座が当日に更新されていれば何も断らない", () => {
    const view = summarizeAccountFreshness(
      [
        { name: "三菱UFJ銀行", lastUpdatedAt: "2026-08-16T23:20:00+09:00" },
        { name: "SBI証券", lastUpdatedAt: "2026-08-16T23:25:00+09:00" },
      ],
      now,
    );

    assert.deepEqual(view.staleAccounts, []);
    assert.equal(view.note, null);
  });

  it("当日でない口座を並べ、記録の判断は呼び出し側に委ねると書く", () => {
    const view = summarizeAccountFreshness(
      [
        { name: "三菱UFJ銀行", lastUpdatedAt: "2026-08-16T23:20:00+09:00" },
        { name: "ゆうちょ銀行", lastUpdatedAt: "2024-12-18T10:00:00+09:00" },
      ],
      now,
    );

    assert.deepEqual(
      view.staleAccounts.map((account) => account.name),
      ["ゆうちょ銀行"],
    );
    assert.match(view.note ?? "", /ゆうちょ銀行/);
    assert.match(view.note ?? "", /呼び出し側で判断/);
  });

  it("口座が多い場合は先頭だけ並べて残りは件数で示す", () => {
    const accounts = Array.from({ length: 8 }, (_, index) => ({
      name: `口座${index + 1}`,
      lastUpdatedAt: "2026-08-15T23:20:00+09:00",
    }));

    const view = summarizeAccountFreshness(accounts, now);

    assert.equal(view.staleAccounts.length, 8);
    assert.match(view.note ?? "", /ほか3件/);
    assert.equal(view.note?.includes("口座6"), false);
  });

  it("最終更新を持たない古いキャッシュでは、その旨だけを断る", () => {
    // この項目を持たない時期の巡回結果がキャッシュに残っていることがある。
    const view = summarizeAccountFreshness([], now);

    assert.deepEqual(view.staleAccounts, []);
    assert.match(view.note ?? "", /取得できていない/);
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
