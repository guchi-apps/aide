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

type Row = { date: string; hour: number; kwh: number };

function datesBetween(start: string, end: string): string[] {
  const dates: string[] = [];
  for (let ms = Date.parse(`${start}T00:00:00Z`); ms <= Date.parse(`${end}T00:00:00Z`); ms += 24 * 60 * 60 * 1000) {
    dates.push(new Date(ms).toISOString().slice(0, 10));
  }
  return dates;
}

/** kurashio#823 と同じく、期間内で記録の無い時間を日ごとにまとめる。 */
function missingOf(rows: Row[], start: string, end: string) {
  const have = new Set(rows.map((r) => `${r.date}#${r.hour}`));
  return datesBetween(start, end)
    .map((date) => ({ date, hours: Array.from({ length: 24 }, (_, h) => h).filter((h) => !have.has(`${date}#${h}`)) }))
    .filter((d) => d.hours.length > 0);
}

/**
 * 保存値の偽物。kurashio#823 と同じく既存値と突き合わせ、上書きせずに created / unchanged / conflict を返す。
 * 照会は期間から expected_count と missing を計算する。
 */
function fakeKurashio(options: { importResponse?: () => Response; readResponse?: () => Response; stored?: Row[]; readBack?: boolean } = {}) {
  const stored: Row[] = [...(options.stored ?? [])];
  const calls: { method: string; path: string; token: string | null; body: any }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const sent = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method: init?.method ?? "GET", path: url.pathname, token: headers.get("authorization"), body: sent });
    if (init?.method === "POST") {
      if (options.importResponse) return options.importResponse();
      const current = new Map(stored.map((r) => [`${r.date}#${r.hour}`, r.kwh]));
      const fresh: Row[] = [];
      const conflicts: Record<string, unknown>[] = [];
      for (const r of sent.records as Row[]) {
        const kwh = current.get(`${r.date}#${r.hour}`);
        if (kwh === undefined) fresh.push(r);
        else if (kwh !== r.kwh) conflicts.push({ date: r.date, hour: r.hour, existing_kwh: kwh, kwh: r.kwh });
      }
      const unchanged = sent.records.length - fresh.length - conflicts.length;
      if (conflicts.length === 0) stored.push(...fresh);
      const status = conflicts.length > 0 ? "conflict" : fresh.length > 0 ? "created" : "unchanged";
      return json(200, {
        status,
        created: conflicts.length > 0 ? 0 : fresh.length,
        unchanged,
        conflict_count: conflicts.length,
        conflicts,
        missing: missingOf(stored, sent.period_start, sent.period_end),
      });
    }
    if (options.readResponse) return options.readResponse();
    const start = url.searchParams.get("start")!;
    const end = url.searchParams.get("end")!;
    const rows = options.readBack === false ? [] : stored.filter((r) => r.date >= start && r.date <= end);
    return json(200, {
      start,
      end,
      count: rows.length,
      expected_count: datesBetween(start, end).length * 24,
      total_kwh: rows.reduce((sum, r) => sum + r.kwh, 0),
      days: [],
      records: rows.map((r) => ({ ...r, imported_at: null })),
      missing: missingOf(rows, start, end),
    });
  }) as typeof fetch;
  return { fetchImpl, calls, stored };
}

/** はぴeみる電のCSVと同じ形（月をまたぐ抽出対象期間・日付は MM/DD・各日24時間）。 */
function csvLikeArgs(periodStart: string, periodEnd: string, kwhOf: (date: string, hour: number) => number | null = (_d, h) => 0.1 + h / 100) {
  return {
    periodStart,
    periodEnd,
    days: datesBetween(periodStart, periodEnd).map((date) => ({
      date: `${date.slice(5, 7)}/${date.slice(8, 10)}`,
      hourly: Array.from({ length: 24 }, (_, h) => kwhOf(date, h)),
    })),
  };
}

const FULL = csvLikeArgs("2026-09-20", "2026-10-20");

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
    const args = csvLikeArgs("2026-10-01", "2026-10-02");
    const res = await createKurashioImportKepcoHourlyTool(deps(k.fetchImpl)).handler(args, { sessionId: null });
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

  it("31日×24時間・月またぎのCSV相当を登録し、744件がそろって初めて created", async () => {
    const k = fakeKurashio();
    const res = await createKurashioImportKepcoHourlyTool(deps(k.fetchImpl)).handler(FULL, { sessionId: null });
    const out = body(res);
    assert.equal(out["status"], "created");
    assert.equal(out["created"], 744);
    assert.deepEqual({ count: out["stored"]["count"], expectedCount: out["stored"]["expectedCount"] }, { count: 744, expectedCount: 744 });
    const post = k.calls.find((c) => c.method === "POST")!;
    assert.equal(post.body.records.length, 744);
    // 年を期間から復元し、暦月ではなく抽出対象期間で日付が決まる
    assert.equal(post.body.records[0].date, "2026-09-20");
    assert.equal(post.body.records.at(-1).date, "2026-10-20");
    assert.equal(new Set(post.body.records.map((r: Row) => r.date.slice(0, 7))).size, 2);
  });

  it("同じ内容の再送は unchanged で、何も書き換えない", async () => {
    const k = fakeKurashio();
    const tool = createKurashioImportKepcoHourlyTool(deps(k.fetchImpl));
    assert.equal(body(await tool.handler(FULL, { sessionId: null }))["status"], "created");
    const again = await tool.handler(FULL, { sessionId: null });
    assert.equal(body(again)["status"], "unchanged");
    assert.notEqual(again.isError, true);
    assert.equal(k.stored.length, 744);
  });

  it("既存値と食い違う再送は conflict で、1件も書かない", async () => {
    const k = fakeKurashio();
    const tool = createKurashioImportKepcoHourlyTool(deps(k.fetchImpl));
    await tool.handler(FULL, { sessionId: null });
    const changed = csvLikeArgs("2026-09-20", "2026-10-20", (d, h) => (d === "2026-10-01" && h === 7 ? 9.9 : 0.1 + h / 100));
    const res = await tool.handler(changed, { sessionId: null });
    assert.equal(body(res)["status"], "conflict");
    assert.equal(res.isError, true);
    assert.deepEqual(body(res)["conflicts"], [{ date: "2026-10-01", hour: 7, existingKwh: 0.17, kwh: 9.9 }]);
    assert.equal(k.stored.find((r) => r.date === "2026-10-01" && r.hour === 7)!.kwh, 0.17);
  });

  it("期間内に未公開の時間が残れば、送った分を保存しても incomplete（登録済みにしない）", async () => {
    const k = fakeKurashio();
    const partial = csvLikeArgs("2026-09-20", "2026-10-20", (d, h) => (d === "2026-10-20" && h >= 12 ? null : 0.2));
    const res = await createKurashioImportKepcoHourlyTool(deps(k.fetchImpl)).handler(partial, { sessionId: null });
    const out = body(res);
    assert.equal(out["status"], "incomplete");
    assert.equal(res.isError, true);
    assert.equal(out["written"], true);
    assert.equal(out["missingCount"], 12);
    assert.deepEqual(out["missing"], [{ date: "2026-10-20", hours: [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23] }]);
    assert.deepEqual(out["stored"], { count: 732, expectedCount: 744, totalKwh: out["stored"]["totalKwh"] });
    // 空欄は0で埋めて送らない
    assert.equal(k.calls.find((c) => c.method === "POST")!.body.records.length, 732);
  });

  it("日付行が足りない（期間より短い）ときも incomplete", async () => {
    const k = fakeKurashio();
    const short = { ...FULL, days: FULL.days.slice(0, 30) };
    const res = await createKurashioImportKepcoHourlyTool(deps(k.fetchImpl)).handler(short, { sessionId: null });
    assert.equal(body(res)["status"], "incomplete");
    assert.deepEqual(body(res)["missing"].map((d: { date: string }) => d.date), ["2026-10-20"]);
  });

  it("保存済みでも期間に欠けが残る再送は unchanged ではなく incomplete", async () => {
    const k = fakeKurashio();
    const partial = { ...FULL, days: FULL.days.slice(0, 30) };
    const tool = createKurashioImportKepcoHourlyTool(deps(k.fetchImpl));
    await tool.handler(partial, { sessionId: null });
    const again = await tool.handler(partial, { sessionId: null });
    assert.equal(body(again)["status"], "incomplete");
    assert.equal(body(again)["written"], false);
    assert.equal(again.isError, true);
  });

  it("書込トークンの認証失敗（401）は unauthorized で、読み戻しも再送もしない", async () => {
    const k = fakeKurashio({ importResponse: () => json(401, { detail: "Invalid internal API token" }) });
    const res = await createKurashioImportKepcoHourlyTool(deps(k.fetchImpl)).handler(FULL, { sessionId: null });
    assert.equal(body(res)["status"], "unauthorized");
    assert.equal(res.isError, true);
    assert.equal(k.calls.filter((c) => c.method === "POST").length, 1);
    assert.equal(k.calls.filter((c) => c.method === "GET").length, 0);
    assert.ok(!JSON.stringify(body(res)).includes("write-token"));
  });

  it("kurashio 側でトークンが未発行（503）は not_configured", async () => {
    const k = fakeKurashio({ importResponse: () => json(503, { detail: "MYROOM_INTERNAL_KEPCO_WRITE_API_KEY is not configured" }) });
    const res = await createKurashioImportKepcoHourlyTool(deps(k.fetchImpl)).handler(FULL, { sessionId: null });
    assert.equal(body(res)["status"], "not_configured");
    assert.equal(res.isError, true);
  });

  it("保存後の照会が失敗したら unverified と照会手順を返す", async () => {
    const k = fakeKurashio({ readResponse: () => json(500, { detail: "internal error" }) });
    const res = await createKurashioImportKepcoHourlyTool(deps(k.fetchImpl)).handler(FULL, { sessionId: null });
    assert.equal(body(res)["status"], "unverified");
    assert.equal(res.isError, true);
    assert.deepEqual(body(res)["lookup"]["arguments"], { start: "2026-09-20", end: "2026-10-20" });
    assert.equal(k.calls.filter((c) => c.method === "POST").length, 1);
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
