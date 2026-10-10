import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createWorkReportStore } from "../../core/work-reports/store.ts";
import { buildToolRegistry } from "../catalog.ts";
import { createReportWorkTool, createWorkReportsTool } from "./work-reports.ts";

const NOW = new Date("2026-10-10T03:00:00Z");

async function tools() {
  const dir = await mkdtemp(join(tmpdir(), "aide-work-tool-"));
  const store = createWorkReportStore(join(dir, "w.json"), () => NOW);
  return { report: createReportWorkTool(() => store, () => NOW), read: createWorkReportsTool(() => store) };
}

const args = (o: Record<string, unknown> = {}) => ({
  workId: "w1", eventId: "e1", version: 1, status: "started", occurredAt: "2026-10-10T12:00:00+09:00", title: "作業", ...o,
});
const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text);

describe("作業報告ツール", () => {
  it("読み取りと書き込みは別scopeで、カタログに登録されている", () => {
    const registry = buildToolRegistry();
    assert.deepEqual(registry.get("aide_report_work")?.requiredScopes, ["work-reports:write"]);
    assert.deepEqual(registry.get("aide_work_reports")?.requiredScopes, ["work-reports:read"]);
  });

  it("保存成功の情報を返し、読取ツールから同じ状態が読める", async () => {
    const { report, read } = await tools();
    const out = parse(await report.handler(args(), { sessionId: null, clientId: "client-1" }));
    assert.deepEqual([out.ok, out.result, out.saved, out.work.version, out.work.reporter], [true, "applied", true, 1, "client-1"]);
    const listed = parse(await read.handler({}, { sessionId: null }));
    assert.deepEqual([listed.works[0].workId, listed.works[0].status], ["w1", "started"]);
  });

  it("自己申告の所有者・不正入力・競合はエラーとして返す", async () => {
    const { report } = await tools();
    const ctx = { sessionId: null, clientId: "c" };
    assert.equal((await report.handler(args({ owner: "x" }), ctx)).isError, true);
    assert.equal((await report.handler(args({ version: -1 }), ctx)).isError, true);
    await report.handler(args(), ctx);
    const conflict = await report.handler(args({ title: "変えた" }), ctx);
    assert.equal(conflict.isError, true);
    assert.equal(parse(conflict).kind, "conflict");
  });

  it("接続から報告元を特定できなければ書き込まない", async () => {
    const { report, read } = await tools();
    const out = await report.handler(args(), { sessionId: null });
    assert.equal(out.isError, true);
    assert.equal(parse(await read.handler({}, { sessionId: null })).reportState, "none");
  });
});
