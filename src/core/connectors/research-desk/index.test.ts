import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  importWeeklyReport,
  normalizeWeeklyReportInput,
  readResearchDeskConfig,
  type ResearchDeskWeeklyReportInput,
} from "./index.ts";

const config = { url: "https://research.example.test", token: "service-secret" };

function article(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    business: "DELIVERY",
    informationType: "NEW_PRODUCT",
    title: "宅配ロッカーの新製品が発表された",
    url: "https://news.example.test/articles/1",
    sourceName: "物流ニュース",
    summary: "概要。",
    implications: "商品企画への示唆。",
    importance: "HIGH",
    keywords: ["宅配", "新製品"],
    periodScope: "IN_SCOPE",
    ...overrides,
  };
}

function validArgs(articles: Record<string, unknown>[] = [article()]): Record<string, unknown> {
  return {
    executedAt: "2026-08-30T18:00:00+09:00",
    targetFrom: "2026-08-23T18:00:00+09:00",
    targetTo: "2026-08-30T18:00:00+09:00",
    articles,
  };
}

const succeededBody = {
  runId: "run-1",
  status: "SUCCEEDED",
  insertedCount: 2,
  duplicateCount: 1,
  failedCount: 0,
  businessCounts: { DELIVERY: 2, LOCKER: 1 },
  duplicateBusinessCounts: { DELIVERY: 0, LOCKER: 1 },
  errors: [],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("research-desk config", () => {
  it("URLとトークンが揃わなければ未設定として扱う", () => {
    assert.equal(readResearchDeskConfig({}), null);
    assert.equal(readResearchDeskConfig({ AIDE_RESEARCH_DESK_URL: "https://research.example.test" }), null);
    assert.equal(
      readResearchDeskConfig({ AIDE_RESEARCH_DESK_URL: "ftp://research.example.test", AIDE_RESEARCH_DESK_TOKEN: "x" }),
      null,
    );
  });

  it("末尾のスラッシュを落とす", () => {
    const result = readResearchDeskConfig({
      AIDE_RESEARCH_DESK_URL: "https://research.example.test/",
      AIDE_RESEARCH_DESK_TOKEN: " service-secret ",
    });
    assert.deepEqual(result, { url: "https://research.example.test", token: "service-secret" });
  });
});

describe("research-desk 週報入力の検証", () => {
  it("日時をISO 8601へ正規化する", () => {
    const result = normalizeWeeklyReportInput(validArgs());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.input.executedAt, "2026-08-30T09:00:00.000Z");
    assert.equal(result.input.targetFrom, "2026-08-23T09:00:00.000Z");
    assert.equal(result.input.articles[0]?.title, "宅配ロッカーの新製品が発表された");
  });

  it("必須の日時・順序を検証する", () => {
    assert.equal(normalizeWeeklyReportInput({ ...validArgs(), executedAt: "先週の日曜" }).ok, false);
    assert.equal(normalizeWeeklyReportInput({ ...validArgs(), targetTo: undefined }).ok, false);
    const reversed = normalizeWeeklyReportInput({
      ...validArgs(),
      targetFrom: "2026-08-30T18:00:00+09:00",
      targetTo: "2026-08-23T18:00:00+09:00",
    });
    assert.equal(reversed.ok, false);
  });

  it("記事は1〜10件、1事業あたり5件までに制限する（#226）", () => {
    assert.equal(normalizeWeeklyReportInput(validArgs([])).ok, false);
    assert.equal(normalizeWeeklyReportInput(validArgs(Array.from({ length: 11 }, () => article()))).ok, false);

    const sixDelivery = normalizeWeeklyReportInput(validArgs(Array.from({ length: 6 }, () => article())));
    assert.equal(sixDelivery.ok, false);
    if (!sixDelivery.ok) assert.match(sixDelivery.reason, /DELIVERY/);

    // 宅配5件＋ロッカー5件の日次10件が通ること。
    const mixed = normalizeWeeklyReportInput(validArgs([
      ...Array.from({ length: 5 }, () => article()),
      ...Array.from({ length: 5 }, () => article({ business: "LOCKER" })),
    ]));
    assert.equal(mixed.ok, true);
    if (mixed.ok) assert.equal(mixed.input.articles.length, 10);
  });

  it("以前までの6件・1事業3件の呼び出しはそのまま通る", () => {
    const legacy = normalizeWeeklyReportInput(validArgs([
      ...Array.from({ length: 3 }, () => article()),
      ...Array.from({ length: 3 }, () => article({ business: "LOCKER" })),
    ]));
    assert.equal(legacy.ok, true);
  });

  it("主要数値は形と大きさだけを検証して素通しする（#226）", () => {
    const metrics = { 設置駅数: 12, ボックス数: 480, 完了予定: "2027-03", 全国展開: true, 備考: null };
    const result = normalizeWeeklyReportInput(validArgs([article({ extractedMetrics: metrics })]));
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.input.articles[0]?.extractedMetrics, metrics);

    // 空オブジェクトは渡さなかったのと同じ扱いにする。
    const empty = normalizeWeeklyReportInput(validArgs([article({ extractedMetrics: {} })]));
    assert.equal(empty.ok, true);
    if (empty.ok) assert.equal(empty.input.articles[0]?.extractedMetrics, undefined);

    for (const invalid of [
      [1, 2],
      "設置台数は12台",
      Object.fromEntries(Array.from({ length: 31 }, (_, index) => [`項目${index}`, index])),
      { 本文: "あ".repeat(2_001) },
      { ["k".repeat(101)]: 1 },
    ]) {
      const rejected = normalizeWeeklyReportInput(validArgs([article({ extractedMetrics: invalid })]));
      assert.equal(rejected.ok, false, `${JSON.stringify(invalid).slice(0, 40)} は不正として扱うべき`);
    }
  });

  it("事業・種別・URL・列挙値の誤りを弾く", () => {
    for (const overrides of [
      { business: "PARCEL" },
      { informationType: "SOMETHING" },
      { url: "example.test/1" },
      { url: "javascript:alert(1)" },
      { title: "  " },
      { sourceName: undefined },
      { importance: "LOW" },
      { periodScope: "LAST_YEAR" },
      { publishedAt: "きのう" },
      { keywords: [1, 2] },
      { isPrimarySource: "yes" },
    ]) {
      const result = normalizeWeeklyReportInput(validArgs([article(overrides)]));
      assert.equal(result.ok, false, `${JSON.stringify(overrides)} は不正として扱うべき`);
    }
  });
});

describe("research-desk 週報の登録", () => {
  const input = (normalizeWeeklyReportInput(validArgs()) as { ok: true; input: ResearchDeskWeeklyReportInput }).input;

  it("未設定なら外部へ送信しない", async () => {
    let called = false;
    const outcome = await importWeeklyReport(input, null, (async () => {
      called = true;
      return jsonResponse(succeededBody);
    }) as unknown as typeof fetch);
    assert.equal(called, false);
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.match(outcome.reason, /未設定/);
  });

  it("AIDE専用内部APIへBearer認証付きで送り、結果をそのまま返す", async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const outcome = await importWeeklyReport(input, config, (async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return jsonResponse(succeededBody);
    }) as unknown as typeof fetch);

    const request = requests[0];
    assert.equal(request?.url, "https://research.example.test/api/internal/weekly-report");
    assert.equal(request?.init.method, "POST");
    const headers = request?.init.headers as Record<string, string>;
    assert.equal(headers["Authorization"], "Bearer service-secret");
    assert.deepEqual(JSON.parse(String(request?.init.body)), input);

    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.equal(outcome.result.runId, "run-1");
      assert.equal(outcome.result.duplicateCount, 1);
      assert.deepEqual(outcome.result.businessCounts, { DELIVERY: 2, LOCKER: 1 });
    }
  });

  it("重複だけの再送も業務上の結果として返す", async () => {
    const outcome = await importWeeklyReport(input, config, (async () =>
      jsonResponse({ ...succeededBody, insertedCount: 0, duplicateCount: 3, duplicateBusinessCounts: { DELIVERY: 2, LOCKER: 1 } })) as unknown as typeof fetch);
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.equal(outcome.result.insertedCount, 0);
      assert.equal(outcome.result.duplicateCount, 3);
    }
  });

  it("HTTPエラーを判断できる理由へ変換し、応答本文を漏らさない", async () => {
    const cases: [number, RegExp][] = [
      [401, /認証/],
      [400, /入力/],
      [404, /接続先URL/],
      [429, /上限/],
      [500, /Research Desk側/],
    ];
    for (const [status, pattern] of cases) {
      const outcome = await importWeeklyReport(input, config, (async () =>
        jsonResponse({ error: "secret-leak" }, status)) as unknown as typeof fetch);
      assert.equal(outcome.ok, false);
      if (!outcome.ok) {
        assert.match(outcome.reason, pattern);
        assert.doesNotMatch(outcome.reason, /secret-leak|service-secret/);
      }
    }
  });

  it("入力エラーはResearch Deskの説明文を添えて返す", async () => {
    const outcome = await importWeeklyReport(input, config, (async () =>
      jsonResponse({ error: "invalid_request", message: "articles[0].urlが不正です" }, 400)) as unknown as typeof fetch);
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.match(outcome.reason, /articles\[0\]\.urlが不正です/);
  });

  it("認証の失敗には応答本文を添えない", async () => {
    const outcome = await importWeeklyReport(input, config, (async () =>
      jsonResponse({ error: "unauthorized", message: "INTERNAL_API_KEYが一致しません" }, 401)) as unknown as typeof fetch);
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.match(outcome.reason, /認証/);
      assert.doesNotMatch(outcome.reason, /INTERNAL_API_KEY/);
    }
  });

  it("タイムアウト・接続失敗を区別して返す", async () => {
    const aborted = await importWeeklyReport(input, config, (async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }) as unknown as typeof fetch);
    assert.equal(aborted.ok, false);
    if (!aborted.ok) assert.match(aborted.reason, /タイムアウト/);

    const failed = await importWeeklyReport(input, config, (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch);
    assert.equal(failed.ok, false);
    if (!failed.ok) assert.match(failed.reason, /接続できません/);
  });

  it("統合更新・除外の件数もそのまま返す（#226 / research-desk#43）", async () => {
    const outcome = await importWeeklyReport(input, config, (async () =>
      jsonResponse({
        ...succeededBody,
        insertedCount: 6,
        mergedCount: 2,
        duplicateCount: 1,
        excludedCount: 1,
        businessCounts: { DELIVERY: 4, LOCKER: 4 },
        supplementalFrom: "2026-08-01T09:00:00.000Z",
      })) as unknown as typeof fetch);
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.equal(outcome.result.mergedCount, 2);
      assert.equal(outcome.result.excludedCount, 1);
      // 契約に無い項目も読み替えずに素通しする。
      assert.equal(outcome.result["supplementalFrom"], "2026-08-01T09:00:00.000Z");
    }
  });

  it("件数の項目が欠けた応答でも runId と status があれば結果として扱う", async () => {
    const outcome = await importWeeklyReport(input, config, (async () =>
      jsonResponse({ runId: "run-2", status: "SUCCEEDED" })) as unknown as typeof fetch);
    assert.equal(outcome.ok, true);
    if (outcome.ok) assert.equal(outcome.result.runId, "run-2");
  });

  it("実行結果を含まない応答は失敗として扱う", async () => {
    const outcome = await importWeeklyReport(input, config, (async () =>
      jsonResponse({ ok: true })) as unknown as typeof fetch);
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.match(outcome.reason, /実行結果/);
  });
});
