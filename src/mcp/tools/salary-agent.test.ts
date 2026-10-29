import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Tool, ToolResult } from "../types.ts";
import {
  createSalaryCommitTool,
  createSalaryLookupTool,
  createSalaryPreviewTool,
  parsePdf,
  parseSource,
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
    assert.equal(parsePdf(Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(700_000)]).toString("base64")).ok, false);
    assert.equal(parsePdf(PDF).ok, true);
  });

  it("元メールの識別にメールボックスを含め、正規化して送る", () => {
    const a = parseSource({ mailbox: " Me@Example.com ", gmailMessageId: " m1 " });
    assert.deepEqual(a.ok && a.source, { mailbox: "me@example.com", messageId: "m1" });
    assert.equal(parseSource({ mailbox: "not-an-address", gmailMessageId: "m1" }).ok, false);
    assert.equal(parseSource({ mailbox: "a@x.com", gmailMessageId: "m 1" }).ok, false);
  });
});

describe("asset_manager_salary_preview", () => {
  it("給与専用トークンで解析を依頼し、保存していないと明示する", async () => {
    const { deps, calls } = fake(() => json(200, { status: "ok", blockers: [], canSave: true, previewToken: "tok" }));
    const r = await run(createSalaryPreviewTool(deps), BASE);
    const body = parse(r);
    assert.equal(r.isError, false);
    assert.equal(body["registered"], false);
    assert.equal(body["previewToken"], "tok");
    assert.equal(calls[0]?.path, "/api/salaries/agent/preview");
    assert.equal(calls[0]?.auth, "Bearer secret-token");
    assert.deepEqual(calls[0]?.body?.["source"], { mailbox: "me@example.com", messageId: "msg-1" });
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
    const { deps, calls } = fake(() => json(201, { status: "created", salaryId: "clx1abc", readPath: "/api/salaries/agent/clx1abc" }));
    const r = await run(createSalaryCommitTool(deps), COMMIT);
    const body = parse(r);
    assert.equal(r.isError, false);
    assert.equal(body["registered"], true);
    assert.equal(body["verified"], false);
    assert.equal(body["salaryId"], "clx1abc");
    assert.equal(calls[0]?.body?.["approved"], true);
    assert.equal(calls[0]?.body?.["salaryDate"], "2026-10-25");
    assert.deepEqual(calls[0]?.body?.["source"], { mailbox: "me@example.com", messageId: "msg-1" });
  });

  it("created の形をしていない2xxや、IDが無い応答は登録できたとしない", async () => {
    const cases: [number, unknown][] = [
      [200, { status: "created", salaryId: "clx1abc" }],
      [201, { status: "created" }],
      [201, { status: "created", salaryId: 42 }],
      [200, { status: "ok" }],
    ];
    for (const [httpStatus, payload] of cases) {
      const { deps } = fake(() => json(httpStatus, payload));
      const r = await run(createSalaryCommitTool(deps), COMMIT);
      assert.equal(r.isError, true, JSON.stringify(payload));
      assert.equal(parse(r)["registered"], "unknown", JSON.stringify(payload));
      assert.equal("salaryId" in parse(r), false);
    }
  });

  it("同じメールの再実行は新規登録ではなく既存IDを示す", async () => {
    const { deps } = fake(() => json(200, { status: "already_imported", message: "すでに登録済みです", salaryId: "clx7" }));
    const r = await run(createSalaryCommitTool(deps), COMMIT);
    const body = parse(r);
    assert.equal(r.isError, true);
    assert.equal(body["status"], "already_registered");
    assert.equal(body["registered"], false);
    assert.equal(body["existingSalaryId"], "clx7");
    assert.equal("salaryId" in body, false);
  });

  it("blockers・期限切れ・同日の既存明細などの拒否は未登録で、既存IDを登録IDと取り違えさせない", async () => {
    const cases: [number, Record<string, unknown>][] = [
      [422, { status: "blocked", message: "この明細は代理登録できません", blockers: [{ code: "unassigned", message: "未割当" }] }],
      [409, { status: "preview_expired", message: "プレビューの有効期限が切れました" }],
      [409, { status: "date_conflict", message: "同じ支給日の給与明細がすでにあります", salaryId: "clx9" }],
      [422, { status: "needs_password", message: "パスワード付きのPDFは代理登録できません", manualImportPath: "/salaries/new" }],
    ];
    for (const [httpStatus, payload] of cases) {
      const { deps } = fake(() => json(httpStatus, payload));
      const r = await run(createSalaryCommitTool(deps), COMMIT);
      const body = parse(r);
      assert.equal(r.isError, true);
      assert.equal(body["registered"], false);
      assert.equal(body["reason"], payload["message"]);
      assert.equal("salaryId" in body, false, JSON.stringify(payload));
      assert.equal(body["httpStatus"], httpStatus);
    }
    const { deps } = fake(() => json(409, { status: "date_conflict", message: "m", salaryId: "clx9" }));
    assert.equal(parse(await run(createSalaryCommitTool(deps), COMMIT))["existingSalaryId"], "clx9");
  });

  it("タイムアウトは unknown で、再送せず先に照会させる", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const { deps } = fake(() => Promise.reject(abort));
    const r = await run(createSalaryCommitTool(deps), COMMIT);
    const body = parse(r);
    assert.equal(r.isError, true);
    assert.equal(body["status"], "unknown");
    assert.equal(body["registered"], "unknown");
    assert.match(String(body["nextStep"]), /asset_manager_salary_preview/);
    assert.match(String(body["nextStep"]), /alreadyImportedSalaryId/);
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
    const { deps, calls } = fake(() => json(200, { status: "ok", salary: { id: "clx1abc", salaryDate: "2026-10-25" } }));
    const body = parse(await run(createSalaryLookupTool(deps), { salaryId: "clx1abc" }));
    assert.equal(body["status"], "found");
    assert.equal(calls[0]?.path, "/api/salaries/agent/clx1abc");
    assert.equal(calls[0]?.method, "GET");
    assert.equal(calls[0]?.auth, "Bearer secret-token");
  });

  it("IDの形が違うものは送らない（パス区切りを持ち込ませない）", async () => {
    const { deps, calls } = fake(() => json(200, {}));
    for (const salaryId of [undefined, "", "../preview", 42, "a b"]) {
      assert.equal((await run(createSalaryLookupTool(deps), { salaryId })).isError, true);
    }
    assert.equal(calls.length, 0);
  });

  it("404 は not_found で、IDを作らない", async () => {
    const { deps } = fake(() => json(404, { status: "not_found", message: "見つかりません" }));
    const r = await run(createSalaryLookupTool(deps), { salaryId: "clx9" });
    assert.equal(parse(r)["status"], "not_found");
    assert.equal("salaryId" in parse(r), false);
  });

  it("401 は連携の失敗として返す", async () => {
    const { deps } = fake(() => json(401, { status: "unauthorized", message: "Unauthorized" }));
    const r = await run(createSalaryLookupTool(deps), { salaryId: "clx9" });
    assert.equal(r.isError, true);
    assert.equal(parse(r)["httpStatus"], 401);
  });
});
