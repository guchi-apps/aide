import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ToolResult } from "../types.ts";
import {
  createKurashioBillContractsTool,
  createKurashioGetBillTool,
  createKurashioImportBillTool,
  parseImportArgs,
  toJstNaive,
  type KurashioBillsDeps,
} from "./kurashio-bills.ts";

const READ = { baseUrl: "http://kurashio.test", token: "read-token" };
const WRITE = { baseUrl: "http://kurashio.test", token: "write-token" };
const KEY = "0123456789ab";

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  token: string | null;
  body: Record<string, unknown> | null;
}

type Handler = (call: Call) => Response | Promise<Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    billing_month: "2026-08",
    kind: "gas",
    contract_key: KEY,
    plan_name: "ガス料金",
    amount_yen: 3210,
    usage_value: 12.3,
    usage_unit: "m3",
    received_at: "2026-09-05T09:12:00",
    updated_at: "2026-10-24T01:00:00",
    revision: "2026-10-24T01:00:00",
    ...overrides,
  };
}

const SOURCE = { source_message_id: "msg-1", source_label: "はぴeみる電", confidence: 0.95, imported_at: "2026-10-24T01:00:00", import_id: 7 };

/** kurashio の内部APIの偽物。路ごとの応答を差し替えて、呼ばれた内容を記録する。 */
function fakeKurashio(routes: Partial<Record<"contracts" | "record" | "import", Handler>>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get("authorization");
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      token: auth?.replace(/^Bearer /, "") ?? null,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
    };
    calls.push(call);
    const route = url.pathname.split("/").pop() as "contracts" | "record" | "import";
    const handler = routes[route];
    if (!handler) return json(404, { detail: "Not Found" });
    return handler(call);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const CONTRACTS: Handler = () => json(200, { contracts: [{ contract_key: KEY, plan_name: "ガス料金", latest_billing_month: "2026-07" }] });

function deps(fetchImpl: typeof fetch, overrides: Partial<KurashioBillsDeps> = {}): KurashioBillsDeps {
  return { readConfig: async () => READ, writeConfig: async () => WRITE, fetchImpl, ...overrides };
}

function body(res: ToolResult): Record<string, unknown> {
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
}

const VALID = {
  billingMonth: "2026-08",
  kind: "gas",
  contractKey: KEY,
  amountYen: 3210,
  usageValue: 12.3,
  usageUnit: "m³",
  receivedAt: "2026-09-05T00:12:00Z",
  sourceMessageId: "msg-1",
  sourceLabel: "はぴeみる電",
  confidence: 0.95,
};

describe("kurashio_import_utility_bill の入力検証", () => {
  it("金額が無ければ insufficient_data で送らない（0円で埋めない）", () => {
    const { amountYen: _, ...rest } = VALID;
    const parsed = parseImportArgs(rest);
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.equal(body(parsed.result)["status"], "insufficient_data");
  });

  it("請求月に日付を渡すと受信日・検針日との取り違えとして弾く", () => {
    for (const billingMonth of ["2026-08-05", "2026-8", "2026-13", "8月分"]) {
      const parsed = parseImportArgs({ ...VALID, billingMonth });
      assert.equal(parsed.ok, false, billingMonth);
    }
  });

  it("水道・不正な契約キー・不正な値を弾く", () => {
    const cases: Record<string, unknown>[] = [
      { kind: "water" },
      { contractKey: "manual" },
      { contractKey: "1234-5678-90" },
      { amountYen: -1 },
      { amountYen: 12.5 },
      { amountYen: "3210" },
      { usageValue: -3 },
      { usageValue: Number.NaN },
      { confidence: 1.2 },
      { confidence: undefined },
      { sourceMessageId: "  " },
      { receivedAt: "2026-09-05T09:12:00" },
      { receivedAt: "2026-09-05" },
    ];
    for (const override of cases) {
      assert.equal(parseImportArgs({ ...VALID, ...override }).ok, false, JSON.stringify(override));
    }
  });

  it("使用量が無いのに単位だけあるのは弾く", () => {
    const { usageValue: _, ...rest } = VALID;
    assert.equal(parseImportArgs(rest).ok, false);
  });

  it("受信日時はJSTのタイムゾーン無しへ揃え、請求月とは別に送る", () => {
    assert.equal(toJstNaive("2026-09-05T00:12:00Z"), "2026-09-05T09:12:00");
    assert.equal(toJstNaive("2026-09-05T09:12:00+09:00"), "2026-09-05T09:12:00");
    const parsed = parseImportArgs(VALID);
    assert.ok(parsed.ok);
    if (parsed.ok) {
      assert.equal(parsed.payload.received_at, "2026-09-05T09:12:00");
      assert.equal(parsed.payload.billing_month, "2026-08");
      // 単位の正規化は kurashio の仕事。そのまま渡す。
      assert.equal(parsed.payload.usage_unit, "m³");
    }
  });
});

describe("kurashio_import_utility_bill", () => {
  it("新規は書込トークンで送り、読み取りトークンで読み戻して一致したときだけ created", async () => {
    const { calls, fetchImpl } = fakeKurashio({
      contracts: CONTRACTS,
      import: () => json(200, { status: "created", record: record(), source: SOURCE }),
      record: () => json(200, { record: record(), source: SOURCE }),
    });
    const res = await createKurashioImportBillTool(deps(fetchImpl)).handler(VALID, { sessionId: null });
    assert.equal(res.isError, false);
    assert.equal(body(res)["status"], "created");
    assert.equal(body(res)["verified"], true);

    const post = calls.find((c) => c.path.endsWith("/import"));
    assert.equal(post?.token, "write-token");
    assert.equal(post?.body?.["source_message_id"], "msg-1");
    const readBack = calls.at(-1);
    assert.equal(readBack?.token, "read-token");
    assert.equal(readBack?.query.get("source_message_id"), "msg-1");
    assert.equal(readBack?.query.get("billing_month"), null);
  });

  it("読み戻せない・値が違うときは unverified で成功扱いにしない", async () => {
    for (const readBack of [
      () => json(404, { detail: "not_found" }),
      () => json(200, { record: record({ amount_yen: 9999 }), source: SOURCE }),
      () => json(500, {}),
    ] as Handler[]) {
      const { fetchImpl } = fakeKurashio({
        contracts: CONTRACTS,
        import: () => json(200, { status: "created", record: record(), source: SOURCE }),
        record: readBack,
      });
      const res = await createKurashioImportBillTool(deps(fetchImpl)).handler(VALID, { sessionId: null });
      assert.equal(res.isError, true);
      assert.equal(body(res)["status"], "unverified");
    }
  });

  it("同一内容は duplicate、値違いは conflict（どちらも上書きしない）", async () => {
    const dup = fakeKurashio({ contracts: CONTRACTS, import: () => json(200, { status: "duplicate", record: record(), source: SOURCE }) });
    const dupRes = await createKurashioImportBillTool(deps(dup.fetchImpl)).handler(VALID, { sessionId: null });
    assert.equal(body(dupRes)["status"], "duplicate");
    assert.equal(dupRes.isError, false);

    const conflict = fakeKurashio({
      contracts: CONTRACTS,
      import: () => json(200, { status: "conflict", record: record({ amount_yen: 4000 }), source: SOURCE, fields: ["amount_yen"] }),
    });
    const res = await createKurashioImportBillTool(deps(conflict.fetchImpl)).handler(VALID, { sessionId: null });
    assert.equal(res.isError, true);
    assert.equal(body(res)["status"], "conflict");
    assert.deepEqual(body(res)["fields"], ["amount_yen"]);
    // 読み戻しも再送もしない
    assert.equal(conflict.calls.filter((c) => c.path.endsWith("/import")).length, 1);
    assert.equal(conflict.calls.filter((c) => c.path.endsWith("/record")).length, 0);
  });

  it("候補に無い契約キーは送らずに contract_unresolved と候補を返す", async () => {
    const { calls, fetchImpl } = fakeKurashio({ contracts: CONTRACTS, import: () => json(200, { status: "created" }) });
    const res = await createKurashioImportBillTool(deps(fetchImpl)).handler({ ...VALID, contractKey: "ffffffffffff" }, { sessionId: null });
    assert.equal(body(res)["status"], "contract_unresolved");
    assert.equal((body(res)["candidates"] as unknown[]).length, 1);
    assert.ok(!calls.some((c) => c.path.endsWith("/import")));
  });

  it("応答待ちが切れたら unknown と出典での照会方法を返す", async () => {
    const timeout = Object.assign(new Error("timeout"), { name: "TimeoutError" });
    const { fetchImpl } = fakeKurashio({ contracts: CONTRACTS, import: () => { throw timeout; } });
    const res = await createKurashioImportBillTool(deps(fetchImpl)).handler(VALID, { sessionId: null });
    assert.equal(body(res)["status"], "unknown");
    const lookup = body(res)["lookup"] as Record<string, unknown>;
    assert.equal(lookup["tool"], "kurashio_get_utility_bill");
    assert.deepEqual(lookup["arguments"], { kind: "gas", contractKey: KEY, sourceMessageId: "msg-1" });
  });

  it("書込の500は unknown、接続できないのは failed として分ける", async () => {
    const e500 = fakeKurashio({ contracts: CONTRACTS, import: () => json(500, { detail: "internal error" }) });
    assert.equal(body(await createKurashioImportBillTool(deps(e500.fetchImpl)).handler(VALID, { sessionId: null }))["status"], "unknown");
    const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const down = fakeKurashio({ contracts: CONTRACTS, import: () => { throw new TypeError("fetch failed", { cause: refused }); } });
    assert.equal(body(await createKurashioImportBillTool(deps(down.fetchImpl)).handler(VALID, { sessionId: null }))["status"], "failed");
  });

  it("送信後に接続が切れた・原因が読めない書込の失敗は unknown と照会方法を返す", async () => {
    const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    for (const thrown of [new TypeError("fetch failed", { cause: reset }), new TypeError("fetch failed")]) {
      const { fetchImpl } = fakeKurashio({ contracts: CONTRACTS, import: () => { throw thrown; } });
      const res = await createKurashioImportBillTool(deps(fetchImpl)).handler(VALID, { sessionId: null });
      assert.equal(body(res)["status"], "unknown");
      assert.equal((body(res)["lookup"] as Record<string, unknown>)["tool"], "kurashio_get_utility_bill");
    }
  });

  it("未設定・認証拒否・未対応を区別する", async () => {
    const { fetchImpl } = fakeKurashio({ contracts: CONTRACTS });
    const noWrite = await createKurashioImportBillTool(deps(fetchImpl, { writeConfig: async () => null })).handler(VALID, { sessionId: null });
    assert.equal(body(noWrite)["status"], "not_configured");
    assert.match(String(body(noWrite)["reason"]), /MYROOM_INTERNAL_BILLS_WRITE_API_KEY/);

    const e401 = fakeKurashio({ contracts: CONTRACTS, import: () => json(401, { detail: "Invalid internal API token" }) });
    assert.equal(body(await createKurashioImportBillTool(deps(e401.fetchImpl)).handler(VALID, { sessionId: null }))["status"], "unauthorized");

    const e503 = fakeKurashio({ contracts: CONTRACTS, import: () => json(503, { detail: "x is not configured" }) });
    assert.equal(body(await createKurashioImportBillTool(deps(e503.fetchImpl)).handler(VALID, { sessionId: null }))["status"], "not_configured");

    const old = fakeKurashio({});
    assert.equal(body(await createKurashioImportBillTool(deps(old.fetchImpl)).handler(VALID, { sessionId: null }))["status"], "unsupported");
  });

  it("422の検証エラーは kurashio の文言を返し、pydanticの配列（入力値を含む）は出さない", async () => {
    const str = fakeKurashio({ contracts: CONTRACTS, import: () => json(422, { detail: "Invalid usage_unit for gas: kWh" }) });
    const res = await createKurashioImportBillTool(deps(str.fetchImpl)).handler(VALID, { sessionId: null });
    assert.equal(body(res)["status"], "invalid");
    assert.match(String(body(res)["reason"]), /usage_unit/);

    const arr = fakeKurashio({ contracts: CONTRACTS, import: () => json(422, { detail: [{ input: "secret-ish" }] }) });
    const text = (await createKurashioImportBillTool(deps(arr.fetchImpl)).handler(VALID, { sessionId: null })).content[0]!.text;
    assert.doesNotMatch(text, /secret-ish/);
  });

  it("dryRun は送らずに、送る内容と同じ月の既存の行を返す", async () => {
    const { calls, fetchImpl } = fakeKurashio({ contracts: CONTRACTS, record: () => json(404, { detail: "not_found" }) });
    const res = await createKurashioImportBillTool(deps(fetchImpl, { writeConfig: async () => null })).handler({ ...VALID, dryRun: true }, { sessionId: null });
    assert.equal(body(res)["status"], "dry_run");
    assert.equal(body(res)["existing"], null);
    assert.equal(body(res)["writeConfigured"], false);
    assert.ok(!calls.some((c) => c.method === "POST"));
  });

  it("応答とエラーにトークンを出さない", async () => {
    const { fetchImpl } = fakeKurashio({
      contracts: CONTRACTS,
      import: () => json(200, { status: "created", record: record(), source: SOURCE }),
      record: () => json(200, { record: record(), source: SOURCE }),
    });
    const text = (await createKurashioImportBillTool(deps(fetchImpl)).handler(VALID, { sessionId: null })).content[0]!.text;
    assert.doesNotMatch(text, /read-token|write-token/);
  });
});

describe("kurashio_get_utility_bill", () => {
  it("月か出典のどちらか一方だけで引く", async () => {
    const { fetchImpl } = fakeKurashio({ record: () => json(200, { record: record(), source: SOURCE }) });
    const tool = createKurashioGetBillTool(deps(fetchImpl));
    assert.equal(body(await tool.handler({ kind: "gas", contractKey: KEY }, { sessionId: null }))["status"], "invalid");
    assert.equal(
      body(await tool.handler({ kind: "gas", contractKey: KEY, billingMonth: "2026-08", sourceMessageId: "m" }, { sessionId: null }))["status"],
      "invalid",
    );
    const found = await tool.handler({ kind: "gas", contractKey: KEY, sourceMessageId: "msg-1" }, { sessionId: null });
    assert.equal(body(found)["status"], "found");
    assert.equal((body(found)["source"] as Record<string, unknown>)["importId"], 7);
  });

  it("未登録（not_found）と未対応のバージョン（Not Found）を区別する", async () => {
    const missing = fakeKurashio({ record: () => json(404, { detail: "not_found" }) });
    const res = await createKurashioGetBillTool(deps(missing.fetchImpl)).handler({ kind: "gas", contractKey: KEY, billingMonth: "2026-08" }, { sessionId: null });
    assert.equal(body(res)["status"], "not_found");
    assert.equal(res.isError, false);

    const old = fakeKurashio({});
    const oldRes = await createKurashioGetBillTool(deps(old.fetchImpl)).handler({ kind: "gas", contractKey: KEY, billingMonth: "2026-08" }, { sessionId: null });
    assert.equal(body(oldRes)["status"], "unsupported");
  });

  it("読み取りトークンが無ければ not_configured", async () => {
    const { fetchImpl } = fakeKurashio({});
    const res = await createKurashioGetBillTool(deps(fetchImpl, { readConfig: async () => null })).handler(
      { kind: "gas", contractKey: KEY, billingMonth: "2026-08" },
      { sessionId: null },
    );
    assert.equal(body(res)["status"], "not_configured");
  });
});

describe("kurashio_utility_bill_contracts", () => {
  it("契約候補を不透明キーのまま返す", async () => {
    const { fetchImpl } = fakeKurashio({ contracts: CONTRACTS });
    const res = await createKurashioBillContractsTool(deps(fetchImpl)).handler({ kind: "gas" }, { sessionId: null });
    assert.deepEqual(body(res)["contracts"], [{ contractKey: KEY, planName: "ガス料金", latestBillingMonth: "2026-07" }]);
  });
});
