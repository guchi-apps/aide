import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ToolResult } from "../types.ts";
import {
  createKurashioGetKepcoHourlyTool,
  createKurashioImportKepcoHourlyTool,
  parseImportArgs,
  resolveMonthDay,
  type KurashioKepcoDeps,
} from "./kurashio-kepco-hourly.ts";

const READ = { baseUrl: "http://kurashio.test", token: "read-token" };
const WRITE = { baseUrl: "http://kurashio.test", token: "write-token" };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function hourly(first: number | null = 0.3, rest: number | null = 0.1): (number | null)[] {
  return [first, ...Array.from({ length: 23 }, () => rest)];
}

const ARGS = {
  periodStart: "2026-10-01",
  periodEnd: "2026-10-02",
  days: [
    { date: "10/02", hourly: hourly() },
    { date: "10/01", hourly: hourly(0.5, null) },
  ],
};

function parse(overrides: Record<string, unknown> = {}) {
  return parseImportArgs({ ...ARGS, ...overrides });
}

function body(res: ToolResult): Record<string, any> {
  return JSON.parse((res.content[0] as { text: string }).text);
}

/** 保存値の偽物。取込で足されたものを照会で返す。 */
function fakeKurashio(options: { importResponse?: () => Response; stored?: { date: string; hour: number; kwh: number }[]; readBack?: boolean } = {}) {
  const stored = [...(options.stored ?? [])];
  const calls: { method: string; path: string; token: string | null; body: any }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const sent = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method: init?.method ?? "GET", path: url.pathname, token: headers.get("authorization"), body: sent });
    if (init?.method === "POST") {
      if (options.importResponse) return options.importResponse();
      for (const r of sent.records) stored.push(r);
      return json(200, { status: "created", created: sent.records.length, unchanged: 0, conflict_count: 0, conflicts: [], missing: [] });
    }
    const rows = options.readBack === false ? [] : stored;
    return json(200, {
      start: url.searchParams.get("start"),
      end: url.searchParams.get("end"),
      count: rows.length,
      expected_count: 48,
      total_kwh: 1,
      days: [],
      records: rows.map((r) => ({ ...r, imported_at: null })),
      missing: [],
    });
  }) as typeof fetch;
  return { fetchImpl, calls, stored };
}

function deps(fetchImpl: typeof fetch, write: boolean = true): KurashioKepcoDeps {
  return { readConfig: async () => READ, writeConfig: async () => (write ? WRITE : null), fetchImpl };
}

describe("parseImportArgs", () => {
  it("MM/DD の年を期間から復元し、空欄は送らず、先頭行相当の項目は持たない", () => {
    const parsed = parse();
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    assert.equal(parsed.payload.records.length, 24 + 1);
    assert.ok(parsed.payload.records.every((r) => Object.keys(r).sort().join() === "date,hour,kwh"));
    assert.deepEqual(parsed.payload.records[0], { date: "2026-10-02", hour: 0, kwh: 0.3 });
    assert.ok(!parsed.payload.records.some((r) => r.date === "2026-10-01" && r.hour > 0));
  });

  it("年またぎの期間でも MM/DD を復元する", () => {
    const start = Date.UTC(2025, 11, 20);
    const end = Date.UTC(2026, 0, 10);
    assert.equal(resolveMonthDay(12, 31, start, end), "2025-12-31");
    assert.equal(resolveMonthDay(1, 5, start, end), "2026-01-05");
    assert.equal(resolveMonthDay(2, 5, start, end), null);
  });

  it("不正な入力は invalid / すべて空欄は insufficient_data", () => {
    for (const overrides of [
      { periodStart: "2026/10/01" },
      { periodEnd: "2026-09-01" },
      { periodEnd: "2026-12-31" },
      { days: [] },
      { days: [{ date: "11/01", hourly: hourly() }] },
      { days: [{ date: "10/01", hourly: [0.1] }] },
      { days: [{ date: "10/01", hourly: hourly(101) }] },
      { days: [{ date: "10/01", hourly: hourly(-1) }] },
      { days: [{ date: "10/01", hourly: hourly("1" as unknown as number) }] },
      { days: [{ date: "10/01", hourly: hourly() }, { date: "2026-10-01", hourly: hourly() }] },
    ]) {
      const parsed = parse(overrides);
      assert.ok(!parsed.ok, JSON.stringify(overrides).slice(0, 60));
      if (!parsed.ok) assert.equal(body(parsed.result)["status"], "invalid");
    }
    const empty = parse({ days: [{ date: "10/01", hourly: hourly(null, null) }] });
    assert.ok(!empty.ok);
    if (!empty.ok) assert.equal(body(empty.result)["status"], "insufficient_data");
  });
});

describe("kurashio_import_kepco_hourly", () => {
  it("登録して読み戻し、一致したときだけ created（書込トークンで送る）", async () => {
    const k = fakeKurashio();
    const res = await createKurashioImportKepcoHourlyTool(deps(k.fetchImpl)).handler(ARGS, { sessionId: null });
    assert.equal(body(res)["status"], "created");
    assert.equal(body(res)["verified"], true);
    const post = k.calls.find((c) => c.method === "POST")!;
    assert.equal(post.token, "Bearer write-token");
    assert.equal(post.path, "/api/internal/energy/kepco-hourly/import");
    assert.deepEqual(Object.keys(post.body).sort(), ["period_end", "period_start", "records"]);
    assert.ok(k.calls.filter((c) => c.method === "GET").every((c) => c.token === "Bearer read-token"));
  });

  it("読み戻せなければ unverified（成功扱いにしない）", async () => {
    const k = fakeKurashio({ readBack: false });
    const res = await createKurashioImportKepcoHourlyTool(deps(k.fetchImpl)).handler(ARGS, { sessionId: null });
    assert.equal(body(res)["status"], "unverified");
    assert.equal(res.isError, true);
  });

  it("conflict は何も確定扱いにせず、既存値と送った値を返す", async () => {
    const k = fakeKurashio({
      importResponse: () =>
        json(200, {
          status: "conflict", created: 0, unchanged: 24, conflict_count: 1,
          conflicts: [{ date: "2026-10-02", hour: 0, existing_kwh: 0.2, kwh: 0.3 }], missing: [],
        }),
    });
    const res = await createKurashioImportKepcoHourlyTool(deps(k.fetchImpl)).handler(ARGS, { sessionId: null });
    assert.equal(body(res)["status"], "conflict");
    assert.deepEqual(body(res)["conflicts"], [{ date: "2026-10-02", hour: 0, existingKwh: 0.2, kwh: 0.3 }]);
    assert.equal(k.calls.filter((c) => c.method === "GET").length, 0);
  });

  it("unchanged は読み戻さずそのまま返す", async () => {
    const k = fakeKurashio({ importResponse: () => json(200, { status: "unchanged", created: 0, unchanged: 25, conflict_count: 0, conflicts: [], missing: [] }) });
    const res = await createKurashioImportKepcoHourlyTool(deps(k.fetchImpl)).handler(ARGS, { sessionId: null });
    assert.equal(body(res)["status"], "unchanged");
    assert.notEqual(res.isError, true);
  });

  it("応答が失われたら unknown と照会手順を返す", async () => {
    const k = fakeKurashio({ importResponse: () => json(502, {}) });
    const res = await createKurashioImportKepcoHourlyTool(deps(k.fetchImpl)).handler(ARGS, { sessionId: null });
    assert.equal(body(res)["status"], "unknown");
    assert.equal(body(res)["lookup"]["tool"], "kurashio_get_kepco_hourly");
  });

  it("書込トークンが無ければ not_configured で何も送らない", async () => {
    const k = fakeKurashio();
    const res = await createKurashioImportKepcoHourlyTool(deps(k.fetchImpl, false)).handler(ARGS, { sessionId: null });
    assert.equal(body(res)["status"], "not_configured");
    assert.equal(k.calls.length, 0);
  });

  it("dryRun は送らずに既存値との差を返す", async () => {
    const k = fakeKurashio({ stored: [{ date: "2026-10-02", hour: 0, kwh: 0.9 }] });
    const res = await createKurashioImportKepcoHourlyTool(deps(k.fetchImpl)).handler({ ...ARGS, dryRun: true }, { sessionId: null });
    const out = body(res);
    assert.equal(out["status"], "dry_run");
    assert.equal(out["sendCount"], 25);
    assert.equal(out["conflictCount"], 1);
    assert.equal(k.calls.filter((c) => c.method === "POST").length, 0);
  });

  it("404 は unsupported（kurashio 未リリース）", async () => {
    const k = fakeKurashio({ importResponse: () => json(404, { detail: "Not Found" }) });
    const res = await createKurashioImportKepcoHourlyTool(deps(k.fetchImpl)).handler(ARGS, { sessionId: null });
    assert.equal(body(res)["status"], "unsupported");
    assert.match(body(res)["reason"], /#823/);
  });
});

describe("kurashio_get_kepco_hourly", () => {
  it("読み取り用トークンで期間を照会する", async () => {
    const k = fakeKurashio({ stored: [{ date: "2026-10-01", hour: 0, kwh: 0.4 }] });
    const res = await createKurashioGetKepcoHourlyTool(deps(k.fetchImpl)).handler({ start: "2026-10-01", end: "2026-10-02" }, { sessionId: null });
    assert.equal(body(res)["status"], "ok");
    assert.equal(body(res)["count"], 1);
    assert.equal(body(res)["records"][0]["kwh"], 0.4);
    assert.equal(k.calls[0]!.token, "Bearer read-token");
  });

  it("期間が不正なら invalid", async () => {
    const k = fakeKurashio();
    const res = await createKurashioGetKepcoHourlyTool(deps(k.fetchImpl)).handler({ start: "2026-10-05", end: "2026-10-01" }, { sessionId: null });
    assert.equal(body(res)["status"], "invalid");
    assert.equal(k.calls.length, 0);
  });
});
