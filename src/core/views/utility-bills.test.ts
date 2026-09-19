import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchZaimPayments, parseZaimApiPayment, type ZaimApiPayment } from "../connectors/zaim/read.ts";
import type { ZaimMaster } from "../connectors/zaim/write.ts";
import {
  buildUtilityBills,
  findUtilityGenres,
  parseUsage,
  shiftMonth,
  summarizeUtilityKind,
  utilityPeriod,
} from "./utility-bills.ts";

const CREDENTIALS = { consumerKey: "k", consumerSecret: "s", accessToken: "t", accessTokenSecret: "ts" };

const MASTER: ZaimMaster = {
  accounts: [],
  categories: [
    { id: 105, name: "水道・光熱" },
    { id: 101, name: "食費" },
  ],
  genres: [
    { id: 10501, name: "水道料金", categoryId: 105 },
    { id: 10502, name: "電気料金", categoryId: 105 },
    { id: 10503, name: "ガス料金", categoryId: 105 },
    { id: 10101, name: "外食", categoryId: 101 },
  ],
};

function payment(date: string, amount: number, name: string, overrides: Partial<ZaimApiPayment> = {}): ZaimApiPayment {
  return { id: Number(date.replaceAll("-", "")), date, amount, categoryId: 105, genreId: 10502, name, place: "東京電力", comment: "", ...overrides };
}

describe("parseUsage", () => {
  it("Asset Managerが品名へ足した使用量を読む", () => {
    assert.deepEqual(parseUsage("電気料金 258kWh"), { value: 258, unit: "kWh" });
    assert.deepEqual(parseUsage("ガス料金 21.4㎥"), { value: 21.4, unit: "m3" });
    assert.deepEqual(parseUsage("ガス料金 12 m3"), { value: 12, unit: "m3" });
    assert.deepEqual(parseUsage("ガス料金 １２ｍ³"), { value: 12, unit: "m3" });
  });

  it("使用量が無ければ null（推測しない）", () => {
    assert.equal(parseUsage("電気料金"), null);
    assert.equal(parseUsage("電気料金 2026年9月分"), null);
  });
});

describe("shiftMonth", () => {
  it("年をまたいで前後へずらす", () => {
    assert.equal(shiftMonth("2026-01", -1), "2025-12");
    assert.equal(shiftMonth("2026-09", -12), "2025-09");
    assert.equal(shiftMonth("2025-12", 1), "2026-01");
  });
});

describe("utilityPeriod", () => {
  it("今月を含めて遡った月の月初から今日（JST）まで", () => {
    // UTCでは8/31だが、JSTでは9/1。
    const period = utilityPeriod(new Date("2026-08-31T16:00:00Z"), 13);
    assert.deepEqual(period, { startDate: "2025-09-01", endDate: "2026-09-01", months: 13 });
  });
});

describe("findUtilityGenres", () => {
  it("ジャンル名で電気・ガスを探し、カテゴリ名を添える", () => {
    assert.deepEqual(findUtilityGenres(MASTER, "electricity"), [{ id: 10502, name: "電気料金", category: "水道・光熱" }]);
    assert.deepEqual(findUtilityGenres(MASTER, "gas"), [{ id: 10503, name: "ガス料金", category: "水道・光熱" }]);
  });
});

describe("summarizeUtilityKind", () => {
  const genres = findUtilityGenres(MASTER, "electricity");

  it("直近・月ごと・前月比・前年同月比を返す", () => {
    const view = summarizeUtilityKind("electricity", genres, [
      payment("2025-09-10", 9000, "電気料金 300kWh"),
      payment("2026-08-12", 8000, "電気料金 280kWh"),
      payment("2026-09-11", 8500, "電気料金 258kWh"),
    ]);

    assert.equal(view.latest?.date, "2026-09-11");
    assert.deepEqual(view.latest?.usage, { value: 258, unit: "kWh" });
    assert.deepEqual(
      view.monthly.map((m) => m.month),
      ["2026-09", "2026-08", "2025-09"],
    );
    assert.deepEqual(view.comparison.previousMonth, {
      month: "2026-08",
      amount: 8000,
      usage: { value: 280, unit: "kWh" },
      amountDiff: 500,
      usageDiff: -22,
    });
    assert.equal(view.comparison.sameMonthLastYear?.month, "2025-09");
    assert.equal(view.comparison.sameMonthLastYear?.amountDiff, -500);
    assert.equal(view.averageMonthlyAmount, 8500);
    assert.equal(view.unavailable, null);
  });

  it("前月に明細が無ければ比較は null（明細のある直前の月へずらさない）", () => {
    const view = summarizeUtilityKind("electricity", genres, [
      payment("2026-07-12", 8000, "電気料金"),
      payment("2026-09-11", 8500, "電気料金"),
    ]);
    assert.equal(view.comparison.previousMonth, null);
  });

  it("同じ月に複数件あれば合算し、使用量はすべて揃うときだけ合計する", () => {
    const both = summarizeUtilityKind("electricity", genres, [
      payment("2026-09-01", 3000, "電気料金 100kWh"),
      payment("2026-09-20", 4000, "電気料金 120kWh", { id: 2 }),
    ]);
    assert.deepEqual(both.monthly[0], { month: "2026-09", amount: 7000, count: 2, usage: { value: 220, unit: "kWh" } });

    const partial = summarizeUtilityKind("electricity", genres, [
      payment("2026-09-01", 3000, "電気料金 100kWh"),
      payment("2026-09-20", 4000, "電気料金", { id: 2 }),
    ]);
    assert.equal(partial.monthly[0]?.usage, null);
  });

  it("明細が無ければ空で返す", () => {
    const view = summarizeUtilityKind("electricity", genres, []);
    assert.equal(view.latest, null);
    assert.deepEqual(view.monthly, []);
    assert.equal(view.averageMonthlyAmount, null);
    assert.equal(view.comparison.previousMonth, null);
  });
});

describe("parseZaimApiPayment", () => {
  it("削除済み・支出以外は落とす", () => {
    const row = { id: 1, mode: "payment", date: "2026-09-11", amount: 8500, category_id: 105, genre_id: 10502, name: "電気料金", place: "", comment: "" };
    assert.equal(parseZaimApiPayment(row)?.amount, 8500);
    assert.equal(parseZaimApiPayment({ ...row, active: -1 }), null);
    assert.equal(parseZaimApiPayment({ ...row, mode: "income" }), null);
  });
});

describe("fetchZaimPayments", () => {
  it("ページを送り、100件未満で止める", async () => {
    const pages: string[] = [];
    const rows = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: i + 1, mode: "payment", date: "2026-09-01", amount: 1, genre_id: 10502 }));
    const outcome = await fetchZaimPayments(CREDENTIALS, { genreId: 10502, startDate: "2025-09-01", endDate: "2026-09-19" }, async (_c, _m, path, params) => {
      assert.equal(path, "/home/money");
      assert.equal(params["genre_id"], "10502");
      pages.push(params["page"]!);
      return { money: rows(pages.length === 1 ? 100 : 3) };
    });
    assert.deepEqual(pages, ["1", "2"]);
    assert.ok(outcome.ok && outcome.payments.length === 103 && !outcome.truncated);
  });

  it("失敗しても例外を投げず理由を返す", async () => {
    const outcome = await fetchZaimPayments(CREDENTIALS, { genreId: 1, startDate: "2026-09-01", endDate: "2026-09-19" }, async () => {
      throw new Response("", { status: 401 });
    });
    assert.equal(outcome.ok, false);
  });
});

describe("buildUtilityBills", () => {
  const now = new Date("2026-09-19T03:00:00Z");

  it("認証情報が無ければ未設定として返す", async () => {
    const view = await buildUtilityBills({ now, credentials: null });
    assert.equal(view.configured, false);
    assert.equal(view.kinds.length, 2);
    assert.ok(view.kinds.every((kind) => kind.unavailable));
  });

  it("種類ごとにジャンルで読み、期間を渡す", async () => {
    const asked: number[] = [];
    const view = await buildUtilityBills({
      now,
      months: 3,
      credentials: CREDENTIALS,
      readMaster: async () => ({ master: MASTER, reason: null }),
      fetchPayments: async (_c, query) => {
        asked.push(query.genreId);
        assert.equal(query.startDate, "2026-07-01");
        assert.equal(query.endDate, "2026-09-19");
        return {
          ok: true,
          truncated: false,
          payments:
            query.genreId === 10503
              ? [payment("2026-09-05", 4000, "ガス料金 12㎥", { genreId: 10503 })]
              : [payment("2026-09-11", 8500, "電気料金 258kWh")],
        };
      },
    });
    assert.deepEqual(asked.sort(), [10502, 10503]);
    assert.deepEqual(
      view.kinds.map((kind) => [kind.kind, kind.latest?.amount, kind.latest?.usage?.unit]),
      [
        ["electricity", 8500, "kWh"],
        ["gas", 4000, "m3"],
      ],
    );
  });

  it("ジャンルが見つからない・取得に失敗した種類だけ unavailable になる", async () => {
    const view = await buildUtilityBills({
      now,
      credentials: CREDENTIALS,
      readMaster: async () => ({ master: { ...MASTER, genres: MASTER.genres.filter((g) => g.id !== 10503) }, reason: null }),
      fetchPayments: async () => ({ ok: false, reason: "HTTP 500（Zaim側の障害）" }),
    });
    assert.equal(view.kinds[0]?.unavailable, "HTTP 500（Zaim側の障害）");
    assert.match(view.kinds[1]?.unavailable ?? "", /ガス/);
  });
});
