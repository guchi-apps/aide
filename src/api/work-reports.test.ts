import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createWorkReportStore } from "../core/work-reports/store.ts";
import { handleWorkReports } from "./work-reports.ts";

const SECRET = "test-only-work-reports-secret";

async function call(opts: { method?: string; auth?: string; url?: string; secret?: string | null; path?: string }) {
  const dir = await mkdtemp(join(tmpdir(), "aide-work-api-"));
  const path = opts.path ?? join(dir, "w.json");
  const store = createWorkReportStore(path);
  const captured = { status: 0, body: "" };
  const res = {
    writeHead(status: number) { captured.status = status; return res; },
    end(body?: string) { captured.body = body ?? ""; return res; },
  };
  const headers: Record<string, string> = {};
  if (opts.auth) headers["authorization"] = opts.auth;
  const req = { method: opts.method ?? "GET", url: opts.url ?? "/api/work-reports", headers } as unknown as IncomingMessage;
  await handleWorkReports(req, res as unknown as ServerResponse, store, opts.secret === undefined ? SECRET : opts.secret);
  return { ...captured, store, path };
}

describe("GET /api/work-reports", () => {
  it("未認証・誤った認証は401、シークレット未設定は503、書込みメソッドは405", async () => {
    assert.equal((await call({})).status, 401);
    assert.equal((await call({ auth: "Bearer wrong" })).status, 401);
    assert.equal((await call({ auth: `Bearer ${SECRET}`, secret: null })).status, 503);
    assert.equal((await call({ auth: `Bearer ${SECRET}`, method: "POST" })).status, 405);
  });

  it("無報告は200で reportState:none、取得失敗は503で空の一覧と区別する", async () => {
    const empty = await call({ auth: `Bearer ${SECRET}` });
    assert.equal(empty.status, 200);
    assert.equal(JSON.parse(empty.body).reportState, "none");

    const dir = await mkdtemp(join(tmpdir(), "aide-work-api-broken-"));
    const broken = join(dir, "w.json");
    await writeFile(broken, "{broken", "utf8");
    assert.equal((await call({ auth: `Bearer ${SECRET}`, path: broken })).status, 503);
  });

  it("不正な limit は400", async () => {
    assert.equal((await call({ auth: `Bearer ${SECRET}`, url: "/api/work-reports?limit=999" })).status, 400);
    assert.equal((await call({ auth: `Bearer ${SECRET}`, url: "/api/work-reports?limit=abc" })).status, 400);
  });
});
