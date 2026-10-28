import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BillRecord } from "../connectors/myroom/bills.ts";
import {
  buildUtilityBills,
  normalizeUnit,
  periodMonths,
  shiftMonth,
  summarizeUtilityKind,
  toUtilityBill,
  utilityPeriod,
} from "./utility-bills.ts";

const CONFIG = { baseUrl: "http://kurashio.test", token: "t" };
const CONTRACT = { contractKey: "abcdef012345", planName: "従量電灯B", latestBillingMonth: "2026-09" };

function record(billingMonth: string, amountYen: number, usageValue: number | null, usageUnit: string | null = "kWh"): BillRecord {
  return {
    billingMonth,
    kind: "electricity",
    contractKey: CONTRACT.contractKey,
    planName: CONTRACT.planName,
    amountYen,
    usageValue,
    usageUnit,
    receivedAt: null,
    updatedAt: null,
    revision: null,
  };
}

function wire(r: BillRecord): Record<string, unknown> {
  return {
    billing_month: r.billingMonth,
    kind: r.kind,
    contract_key: r.contractKey,
    plan_name: r.planName,
    amount_yen: r.amountYen,
    usage_value: r.usageValue,
    usage_unit: r.usageUnit,
  };
}

/** kurashio の内部APIを真似る。`records` に無い月は未登録（404 not_found）。 */
function fakeKurashio(records: BillRecord[], options: { failMonth?: string; contracts?: unknown[] } = {}) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/api/internal/bills/contracts") {
      const kind = url.searchParams.get("kind");
      return json(200, {
        contracts:
          options.contracts ??
          (kind === "electricity"
            ? [{ contract_key: CONTRACT.contractKey, plan_name: CONTRACT.planName, latest_billing_month: CONTRACT.latestBillingMonth }]
            : []),
      });
    }
    const month = url.searchParams.get("billing_month");
    if (month === options.failMonth) return json(500, { detail: "boom" });
    const found = records.find((r) => r.billingMonth === month);
    return found ? json(200, { record: wire(found), source: null }) : json(404, { detail: "not_found" });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("normalizeUnit", () => {
  it("kurashio の単位表記を kWh / m3 へ寄せ、読めない単位は null", () => {
    assert.equal(normalizeUnit("kWh"), "kWh");
    assert.equal(normalizeUnit("KWH"), "kWh");
    assert.equal(normalizeUnit("m³"), "m3");
    assert.equal(normalizeUnit("ｍ３"), "m3");
    assert.equal(normalizeUnit("円"), null);
    assert.equal(normalizeUnit(null), null);
  });
});

describe("toUtilityBill", () => {
  it("使用量は値と単位の両方があるときだけ入れる（推測しない）", () => {
    assert.deepEqual(toUtilityBill(record("2026-09", 8000, 258)).usage, { value: 258, unit: "kWh" });
    assert.equal(toUtilityBill(record("2026-09", 8000, null)).usage, null);
    assert.equal(toUtilityBill(record("2026-09", 8000, 258, null)).usage, null);
  });
});

describe("shiftMonth / utilityPeriod", () => {
  it("年をまたいで前後へずらす", () => {
    assert.equal(shiftMonth("2026-01", -1), "2025-12");
    assert.equal(shiftMonth("2025-12", 1), "2026-01");
  });

  it("今月（JST）を含めて遡った請求月", () => {
    // UTCでは8/31だが、JSTでは9/1。
    const period = utilityPeriod(new Date("2026-08-31T16:00:00Z"), 13);
    assert.deepEqual(period, { startMonth: "2025-09", endMonth: "2026-09", months: 13 });
    assert.deepEqual(periodMonths({ startMonth: "2026-07", endMonth: "2026-09", months: 3 }), ["2026-09", "2026-08", "2026-07"]);
  });
});

describe("summarizeUtilityKind", () => {
  it("前月・前年同月と比べ、平均を出す", () => {
    const bills = [record("2026-09", 9000, 300), record("2026-08", 8000, 250), record("2025-09", 7000, 200)].map(toUtilityBill);
    const view = summarizeUtilityKind("electricity", [CONTRACT], bills);
    assert.equal(view.latest?.billingMonth, "2026-09");
    assert.deepEqual(view.comparison.previousMonth, {
      month: "2026-08",
      amount: 8000,
      usage: { value: 250, unit: "kWh" },
      amountDiff: 1000,
      usageDiff: 50,
    });
    assert.equal(view.comparison.sameMonthLastYear?.amountDiff, 2000);
    assert.equal(view.averageMonthlyAmount, 8000);
  });

  it("請求の無い前月は比較しない（0円とみなさない）", () => {
    const view = summarizeUtilityKind("electricity", [CONTRACT], [toUtilityBill(record("2026-09", 9000, null))]);
    assert.equal(view.comparison.previousMonth, null);
    assert.equal(view.monthly[0]?.usage, null);
  });
});

describe("buildUtilityBills", () => {
  const now = new Date("2026-10-15T00:00:00Z");

  it("接続設定が無ければ configured: false で、kurashio へ問い合わせない", async () => {
    const { fetchImpl, calls } = fakeKurashio([]);
    const view = await buildUtilityBills({ config: null, fetchImpl, now });
    assert.equal(view.configured, false);
    assert.equal(calls.length, 0);
    assert.ok(view.kinds.every((kind) => kind.unavailable));
  });

  it("契約ごとに請求月を引き、最新の請求月より先は問い合わせない", async () => {
    const { fetchImpl, calls } = fakeKurashio([record("2026-09", 9000, 300), record("2026-08", 8000, 250)]);
    const view = await buildUtilityBills({ config: CONFIG, fetchImpl, now, months: 3, kinds: ["electricity"] });
    const electricity = view.kinds[0]!;
    assert.equal(electricity.unavailable, null);
    assert.deepEqual(electricity.monthly.map((m) => m.month), ["2026-09", "2026-08"]);
    assert.ok(!calls.some((call) => call.includes("billing_month=2026-10")), "2026-10 は最新の請求月より先");
    assert.ok(calls.some((call) => call.includes("billing_month=2026-08")));
  });

  it("請求が1件も無い種類は理由を返す", async () => {
    const { fetchImpl } = fakeKurashio([]);
    const view = await buildUtilityBills({ config: CONFIG, fetchImpl, now, kinds: ["gas"] });
    assert.match(view.kinds[0]!.unavailable ?? "", /ガス/);
  });

  it("途中の月で失敗したら一部だけの推移を出さず、種類ごと取得失敗にする", async () => {
    const { fetchImpl } = fakeKurashio([record("2026-09", 9000, 300)], { failMonth: "2026-08" });
    const view = await buildUtilityBills({ config: CONFIG, fetchImpl, now, months: 3, kinds: ["electricity"] });
    const electricity = view.kinds[0]!;
    assert.match(electricity.unavailable ?? "", /2026-08/);
    assert.deepEqual(electricity.bills, []);
  });
});
