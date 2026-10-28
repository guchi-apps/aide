import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Tool, ToolResult } from "../types.ts";
import {
  buildSourceKey,
  createSalaryCommitTool,
  createSalaryLookupTool,
  createSalaryPreviewTool,
  parsePdf,
  type SalaryAgentDeps,
} from "./salary-agent.ts";

const CONFIG = { baseUrl: "http://am.test", token: "secret-token" };
const PDF = Buffer.from("%PDF-1.4 synthetic").toString("base64");
const BASE = { mailbox: "Me@Example.com", gmailMessageId: "msg-1", pdfBase64: PDF };
const COMMIT = { ...BASE, approved: true, salaryDate: "2026-10-25", previewToken: "tok" };

interface Call {
  method: string;
  path: string;
  auth: string | null;
  body: Record<string, unknown> | null;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fake(handler: (call: Call) => Response | Promise<Response>): { deps: SalaryAgentDeps; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname + url.search,
      auth: headers.get("authorization"),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { deps: { readConfig: async () => CONFIG, fetchImpl }, calls };
}

function parse(r: ToolResult): Record<string, unknown> {
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}

async function run(tool: Tool, args: Record<string, unknown>): Promise<ToolResult> {
  return tool.handler(args, { sessionId: null });
}

describe("入力の検証", () => {
  it("PDFでないもの・大きすぎるもの・base64でないものは送らない", () => {
    assert.equal(parsePdf(Buffer.from("hello world!").toString("base64")).ok, false);
    assert.equal(parsePdf("not base64!!").ok, false);
    assert.equal(parsePdf(Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(1_000_001)]).toString("base64")).ok, false);
    assert.equal(parsePdf(PDF).ok, true);
  });

  it("元メールの安定IDにメールボックスを含める", () => {
    assert.equal(buildSourceKey("a@x.com", "m1"), "gmail:a@x.com:m1");
    assert.notEqual(buildSourceKey("a@x.com", "m1"), buildSourceKey("b@x.com", "m1"));
  });
});

describe("asset_manager_salary_preview", () => {
  it("給与専用トークンで解析を依頼し、保存していないと明示する", async () => {
    const { deps, calls } = fake(() => json(200, { blockers: [], dateConfirmed: false, previewToken: "tok" }));
    const r = await run(createSalaryPreviewTool(deps), BASE);
    const body = parse(r);
    assert.equal(r.isError, false);
    assert.equal(body["registered"], false);
    assert.equal(body["previewToken"], "tok");
    assert.equal(calls[0]?.path, "/api/salaries/agent/preview");
    assert.equal(calls[0]?.auth, "Bearer secret-token");
    assert.equal(calls[0]?.body?.["sourceKey"], "gmail:me@example.com:msg-1");
  });

  it("トークン未設定なら送らず未登録と返す", async () => {
    const { calls } = fake(() => json(200, {}));
    const r = await run(createSalaryPreviewTool({ readConfig: async () => null }), BASE);
    assert.equal(parse(r)["status"], "not_configured");
    assert.equal(r.isError, true);
    assert.equal(calls.length, 0);
  });

  it("5xxのHTMLは本文を載せない", async () => {
    const { deps } = fake(() => new Response("<html>secret internals</html>", { status: 502 }));
    const r = await run(createSalaryPreviewTool(deps), BASE);
    assert.equal(r.isError, true);
    assert.ok(!r.content[0]!.text.includes("secret"));
    assert.equal(parse(r)["httpStatus"], 502);
  });
});

describe("asset_manager_salary_commit", () => {
  it("approved: true が無ければ送らない", async () => {
    const { deps, calls } = fake(() => json(200, { salaryId: 1 }));
    for (const approved of [undefined, false, "true"]) {
      const r = await run(createSalaryCommitTool(deps), { ...COMMIT, approved });
      assert.equal(parse(r)["registered"], false);
      assert.equal(r.isError, true);
    }
    assert.equal(calls.length, 0);
  });

  it("支給日・プレビューのトークンが無ければ送らない", async () => {
    const { deps, calls } = fake(() => json(200, { salaryId: 1 }));
    assert.equal((await run(createSalaryCommitTool(deps), { ...COMMIT, salaryDate: "2026-02-30" })).isError, true);
    assert.equal((await run(createSalaryCommitTool(deps), { ...COMMIT, previewToken: "" })).isError, true);
    assert.equal(calls.length, 0);
  });

  it("保存できたときは未検証で返し、読み戻しを促す", async () => {
    const { deps, calls } = fake(() => json(200, { status: "created", salaryId: 42 }));
    const r = await run(createSalaryCommitTool(deps), COMMIT);
    const body = parse(r);
    assert.equal(r.isError, false);
    assert.equal(body["registered"], true);
    assert.equal(body["verified"], false);
    assert.equal(body["salaryId"], 42);
    assert.equal(calls[0]?.body?.["approved"], true);
    assert.equal(calls[0]?.body?.["salaryDate"], "2026-10-25");
  });

  it("blockers・duplicate・needsReview・ID無しは成功扱いにしない", async () => {
    const cases: unknown[] = [
      { status: "created", salaryId: 5, blockers: ["未割当の項目"] },
      { status: "conflict", reason: "同日の明細があります", salaryId: 9 },
      { status: "needsReview" },
      { status: "created" },
    ];
    for (const payload of cases) {
      const { deps } = fake(() => json(200, payload));
      const r = await run(createSalaryCommitTool(deps), COMMIT);
      assert.equal(r.isError, true, JSON.stringify(payload));
      assert.notEqual(parse(r)["registered"], true, JSON.stringify(payload));
    }
  });

  it("同じメールの再実行は新規登録ではなく既存IDを示す", async () => {
    const { deps } = fake(() => json(200, { status: "duplicate", salaryId: 7 }));
    const body = parse(await run(createSalaryCommitTool(deps), COMMIT));
    assert.equal(body["status"], "already_registered");
    assert.equal(body["registered"], false);
    assert.equal(body["existingSalaryId"], 7);
  });

  it("拒否(4xx)は未登録で、IDを作らない", async () => {
    const { deps } = fake(() => json(409, { reason: "同日の明細があります" }));
    const r = await run(createSalaryCommitTool(deps), COMMIT);
    const body = parse(r);
    assert.equal(r.isError, true);
    assert.equal(body["registered"], false);
    assert.equal(body["reason"], "同日の明細があります");
    assert.equal("salaryId" in body, false);
  });

  it("タイムアウトは unknown で、再送せず先に照会させる", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const { deps } = fake(() => Promise.reject(abort));
    const r = await run(createSalaryCommitTool(deps), COMMIT);
    const body = parse(r);
    assert.equal(r.isError, true);
    assert.equal(body["status"], "unknown");
    assert.equal(body["registered"], "unknown");
    assert.match(String(body["nextStep"]), /asset_manager_salary_lookup/);
  });

  it("エラー文にPDFやトークンを含めない", async () => {
    const { deps } = fake(() => Promise.reject(new Error(`boom ${PDF} secret-token`)));
    const r = await run(createSalaryCommitTool(deps), COMMIT);
    assert.ok(!r.content[0]!.text.includes(PDF));
    assert.ok(!r.content[0]!.text.includes("secret-token"));
  });
});

describe("asset_manager_salary_lookup", () => {
  it("Salary ID で読み戻す", async () => {
    const { deps, calls } = fake(() => json(200, { id: 42 }));
    const body = parse(await run(createSalaryLookupTool(deps), { salaryId: 42 }));
    assert.equal(body["status"], "found");
    assert.equal(calls[0]?.path, "/api/salaries/agent/42");
    assert.equal(calls[0]?.method, "GET");
  });

  it("元メールで照会できる", async () => {
    const { deps, calls } = fake(() => json(200, { id: 42 }));
    await run(createSalaryLookupTool(deps), { mailbox: "me@example.com", gmailMessageId: "msg-1" });
    assert.equal(calls[0]?.path, `/api/salaries/agent?sourceKey=${encodeURIComponent("gmail:me@example.com:msg-1")}`);
  });

  it("IDと元メールの両方・どちらも無いは拒否する", async () => {
    const { deps, calls } = fake(() => json(200, {}));
    assert.equal((await run(createSalaryLookupTool(deps), {})).isError, true);
    assert.equal((await run(createSalaryLookupTool(deps), { salaryId: 1, ...BASE })).isError, true);
    assert.equal(calls.length, 0);
  });

  it("404 は not_found で、元メール照会では未登録と断定しない", async () => {
    const { deps } = fake(() => json(404, {}));
    const byId = parse(await run(createSalaryLookupTool(deps), { salaryId: 9 }));
    assert.equal(byId["status"], "not_found");
    const bySource = parse(await run(createSalaryLookupTool(deps), { mailbox: "me@example.com", gmailMessageId: "m" }));
    assert.match(String(bySource["reason"]), /断定せず/);
  });
});
