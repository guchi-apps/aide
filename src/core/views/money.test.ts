import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import { loadFixedCosts, summarizeAccountFreshness, summarizeFixedCosts } from "./money.ts";
import type {
  AssetManagerSubscription,
  AssetManagerSubscriptionsSnapshot,
} from "../connectors/asset-manager/types.ts";

/**
 * `summarizeFixedCosts` は純粋関数なので、テストはここに集中させる。
 * 月額換算・次回請求日・円換算そのものは Asset Manager 側の計算結果で、こちらの責務ではない。
 */

const REFERENCE_DATE = "2026-08-16";

function subscription(overrides: Partial<AssetManagerSubscription> = {}): AssetManagerSubscription {
  return {
    id: 1,
    name: "Netflix",
    category: "SUBSCRIPTION",
    categoryLabel: "サブスクリプション",
    status: "AUTO_RENEWING",
    paymentMethod: "楽天カード",
    amount: 1490,
    currency: "JPY",
    monthlyAmount: 1490,
    monthlyAmountJpy: 1490,
    nextBillingDay: "2026-09-05",
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<Omit<AssetManagerSubscriptionsSnapshot, "summary">> & {
    summary?: Partial<AssetManagerSubscriptionsSnapshot["summary"]>;
  } = {},
): AssetManagerSubscriptionsSnapshot {
  const { summary, ...rest } = overrides;
  return {
    status: "ok",
    asOf: REFERENCE_DATE,
    summary: {
      fixedCostMonthlyTotalJpy: 1490,
      usdJpyRate: 152.3,
      excludedFromTotal: [],
      ...summary,
    },
    subscriptions: [subscription()],
    ...rest,
  };
}

describe("summarizeFixedCosts", () => {
  it("月額合計・明細・支払予定を返す", () => {
    const view = summarizeFixedCosts(snapshot());

    assert.equal(view.configured, true);
    assert.equal(view.unavailable, null);
    assert.equal(view.count, 1);
    assert.deepEqual(view.monthlyByCurrency, [{ currency: "JPY", amount: 1490 }]);
    assert.equal(view.monthlyJpy, 1490);
    assert.equal(view.usdJpyRate, 152.3);
    assert.deepEqual(view.items, [
      {
        name: "Netflix",
        category: "SUBSCRIPTION",
        categoryLabel: "サブスクリプション",
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

  it("保険・税金・分割払いも固定費として含め、区分を明細に残す", () => {
    const view = summarizeFixedCosts(
      snapshot({
        summary: { fixedCostMonthlyTotalJpy: 2390 },
        subscriptions: [
          subscription(),
          subscription({
            id: 2,
            name: "火災保険",
            category: "INSURANCE",
            categoryLabel: "保険・共済",
            amount: 900,
            monthlyAmount: 900,
            monthlyAmountJpy: 900,
          }),
        ],
      }),
    );

    assert.equal(view.count, 2);
    assert.deepEqual(view.monthlyByCurrency, [{ currency: "JPY", amount: 2390 }]);
    assert.equal(view.monthlyJpy, 2390);
    assert.deepEqual(
      view.items.map((item) => [item.name, item.category, item.categoryLabel]),
      [
        ["Netflix", "SUBSCRIPTION", "サブスクリプション"],
        ["火災保険", "INSURANCE", "保険・共済"],
      ],
    );
    assert.match(view.note, /保険・税金・分割払い/);
  });

  it("次回の支払額は1回あたりの請求額を使い、月額換算とは別に持つ", () => {
    const view = summarizeFixedCosts(
      snapshot({
        summary: { fixedCostMonthlyTotalJpy: 186 },
        subscriptions: [
          subscription({
            name: "ドメイン（年払い）",
            amount: 2232,
            monthlyAmount: 186,
            monthlyAmountJpy: 186,
            nextBillingDay: "2026-11-23",
          }),
          subscription({
            id: 2,
            name: "iCloud",
            amount: 180,
            monthlyAmount: 180,
            monthlyAmountJpy: 180,
            nextBillingDay: "2026-08-23",
          }),
        ],
      }),
    );

    // 年払いは31日より先なので予定に出ず、月額換算のほうだけが明細に載る。
    assert.deepEqual(view.upcoming, [
      { name: "iCloud", date: "2026-08-23", amount: 180, currency: "JPY" },
    ]);
    assert.equal(view.items[0]?.monthlyAmount, 186);
  });

  it("通貨をまたいで合算せず、混在していることを note に断る", () => {
    const view = summarizeFixedCosts(
      snapshot({
        summary: { fixedCostMonthlyTotalJpy: 5447 },
        subscriptions: [
          subscription(),
          subscription({
            id: 2,
            name: "GitHub Copilot",
            amount: 100,
            currency: "USD",
            monthlyAmount: 8.33,
            monthlyAmountJpy: 1269,
            nextBillingDay: "2026-12-01",
          }),
          subscription({
            id: 3,
            name: "ChatGPT Plus",
            amount: 17.65,
            currency: "USD",
            monthlyAmount: 17.65,
            monthlyAmountJpy: 2688,
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

  it("円換算できない契約があれば円換算の合計を出さず、その旨と契約名を note に残す", () => {
    const view = summarizeFixedCosts(
      snapshot({
        summary: { usdJpyRate: null, fixedCostMonthlyTotalJpy: 1490, excludedFromTotal: ["ChatGPT Plus"] },
        subscriptions: [
          subscription(),
          subscription({
            id: 2,
            name: "ChatGPT Plus",
            amount: 25.98,
            currency: "USD",
            monthlyAmount: 25.98,
            monthlyAmountJpy: null,
          }),
        ],
      }),
    );

    // 部分的な合計（1490円）を返すと、実際より少ない額が固定費として読まれる。
    assert.equal(view.monthlyJpy, null);
    assert.equal(view.usdJpyRate, null);
    assert.match(view.note, /為替レートを取得できなかった/);
    assert.match(view.note, /ChatGPT Plus/);
  });

  it("支払予定は31日以内だけを日付の昇順で返す", () => {
    const view = summarizeFixedCosts(
      snapshot({
        subscriptions: [
          subscription({ id: 1, name: "31日後（含む）", amount: 100, nextBillingDay: "2026-09-16" }),
          subscription({ id: 2, name: "32日後（含まない）", amount: 200, nextBillingDay: "2026-09-17" }),
          subscription({ id: 3, name: "当日（含む）", amount: 300, nextBillingDay: REFERENCE_DATE }),
          subscription({ id: 4, name: "支払予定なし", nextBillingDay: null }),
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
      snapshot({ summary: { fixedCostMonthlyTotalJpy: 0 }, subscriptions: [] }),
    );

    assert.equal(view.configured, true);
    assert.equal(view.count, 0);
    assert.deepEqual(view.monthlyByCurrency, []);
    assert.deepEqual(view.monthlyByPaymentMethod, []);
    assert.deepEqual(view.upcoming, []);
  });

  it("解約済みが混ざっていても、いま払っているものには数えない", () => {
    const view = summarizeFixedCosts(
      snapshot({
        subscriptions: [
          subscription(),
          subscription({ id: 2, name: "解約済み", status: "ENDED", nextBillingDay: null, monthlyAmount: 980 }),
        ],
      }),
    );

    assert.equal(view.count, 1);
    assert.deepEqual(view.monthlyByCurrency, [{ currency: "JPY", amount: 1490 }]);
    assert.deepEqual(
      view.items.map((item) => item.name),
      ["Netflix"],
    );
  });

  it("契約状況と支払方法を明細へそのまま通す", () => {
    const view = summarizeFixedCosts(
      snapshot({
        summary: { fixedCostMonthlyTotalJpy: 2470 },
        subscriptions: [
          subscription(),
          subscription({
            id: 2,
            name: "解約予定のサービス",
            paymentMethod: "三菱UFJ銀行",
            status: "SCHEDULED_TO_END",
            amount: 980,
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
        summary: { fixedCostMonthlyTotalJpy: 3450 },
        subscriptions: [
          subscription(),
          subscription({ id: 2, name: "Spotify", amount: 980, monthlyAmount: 980, monthlyAmountJpy: 980 }),
          subscription({
            id: 3,
            name: "電気",
            paymentMethod: "三菱UFJ銀行",
            amount: 980,
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
        summary: { fixedCostMonthlyTotalJpy: 5447 },
        subscriptions: [
          subscription(),
          subscription({
            id: 2,
            name: "GitHub Copilot",
            amount: 12.99,
            currency: "USD",
            monthlyAmount: 12.99,
            monthlyAmountJpy: 1978,
          }),
          subscription({
            id: 3,
            name: "ChatGPT Plus",
            amount: 12.99,
            currency: "USD",
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

describe("loadFixedCosts", () => {
  const KEYS = ["AIDE_ASSET_MANAGER_ZAIM_SYNC_SECRET", "AIDE_ASSET_MANAGER_URL"] as const;
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

  afterEach(() => {
    mock.restoreAll();
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("シークレットが未設定なら取得を試みず、固定費が無いという意味ではないと断る", async () => {
    delete process.env["AIDE_ASSET_MANAGER_ZAIM_SYNC_SECRET"];
    const fetchMock = mock.method(globalThis, "fetch");

    const view = await loadFixedCosts();

    assert.equal(view.configured, false);
    assert.deepEqual(view.unavailable, { source: "asset-manager", reason: "接続が設定されていない" });
    assert.match(view.note, /固定費が無いという意味ではない/);
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  it("Asset Manager の一覧を畳んで返す（解約済みは要求しない）", async () => {
    process.env["AIDE_ASSET_MANAGER_ZAIM_SYNC_SECRET"] = "secret-value";
    process.env["AIDE_ASSET_MANAGER_URL"] = "https://asset.example.test/";
    const fetchMock = mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
      assert.equal(input, "https://asset.example.test/api/subscriptions");
      assert.equal((init?.headers as Record<string, string>)["authorization"], "Bearer secret-value");
      return new Response(JSON.stringify(snapshot()), { status: 200 });
    });

    const view = await loadFixedCosts();

    assert.equal(fetchMock.mock.callCount(), 1);
    assert.equal(view.configured, true);
    assert.equal(view.unavailable, null);
    assert.equal(view.count, 1);
  });

  it("取得に失敗しても投げず、理由をステータスまで丸めて返す（URLとシークレットは載せない）", async () => {
    process.env["AIDE_ASSET_MANAGER_ZAIM_SYNC_SECRET"] = "secret-value";
    process.env["AIDE_ASSET_MANAGER_URL"] = "https://asset.example.test";

    for (const [response, reason] of [
      [new Response("{}", { status: 401 }), "HTTP 401（シークレットが一致しない）"],
      [new Response("{}", { status: 404 }), "HTTP 404（Asset Manager側で対象ユーザーが見つからない）"],
      [new Response("<html>Bad Gateway</html>", { status: 502 }), "HTTP 502"],
      [new Response("<html>not json</html>", { status: 200 }), "JSONとして読めない応答が返った"],
      [new Response(JSON.stringify({ status: "ok" }), { status: 200 }), "想定と異なる形の応答が返った"],
    ] as const) {
      mock.method(globalThis, "fetch", async () => response);
      const view = await loadFixedCosts();
      mock.restoreAll();

      assert.equal(view.configured, true);
      assert.deepEqual(view.unavailable, { source: "asset-manager", reason });
      assert.equal(view.count, 0);
      assert.equal(JSON.stringify(view).includes("secret-value"), false);
      assert.equal(JSON.stringify(view).includes("asset.example.test"), false);
    }

    mock.method(globalThis, "fetch", async () => {
      throw new TypeError("fetch failed: https://asset.example.test");
    });
    const view = await loadFixedCosts();
    assert.equal(view.unavailable?.reason, "接続できなかった");
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
