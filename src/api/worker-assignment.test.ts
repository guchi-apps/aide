import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

process.env["AIDE_WORKER_ASSIGNMENT_PATH"] = join(await mkdtemp(join(tmpdir(), "aide-worker-api-")), "state.json");
const { handleWorkerAssignment, handleWorkerClaim } = await import("./worker-assignment.ts");
const { resetAssignmentForTest } = await import("../core/worker-assignment.ts");

const INGEST = "test-ingest";
const STATUS = "test-status";
const CONTROL = "test-control";

interface Captured {
  status: number;
  body: string;
}

function fakeRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: "" };
  const res = {
    writeHead(status: number) {
      captured.status = status;
      return res;
    },
    end(body?: string) {
      captured.body = body ?? "";
      return res;
    },
  };
  return { res: res as unknown as ServerResponse, captured };
}

function fakeReq(method: string, body: unknown, token: string | null): IncomingMessage {
  const headers: Record<string, string> = {};
  if (token !== null) headers["authorization"] = `Bearer ${token}`;
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body), "utf8");
    },
  } as unknown as IncomingMessage;
}

async function call(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  method: string,
  body: unknown,
  token: string | null,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const { res, captured } = fakeRes();
  await handler(fakeReq(method, body, token), res);
  return { status: captured.status, json: JSON.parse(captured.body || "{}") };
}

before(() => {
  process.env["AIDE_INGEST_SECRET"] = INGEST;
  process.env["AIDE_STATUS_SECRET"] = STATUS;
  process.env["AIDE_WORKER_CONTROL_SECRET"] = CONTROL;
});
beforeEach(() => resetAssignmentForTest());
after(() => {
  delete process.env["AIDE_INGEST_SECRET"];
  delete process.env["AIDE_STATUS_SECRET"];
  delete process.env["AIDE_WORKER_CONTROL_SECRET"];
  delete process.env["AIDE_WORKER_ASSIGNMENT_PATH"];
});

describe("POST /api/worker/claim", () => {
  it("worker のシークレットで問い合わせ、主（subpc）なら動かしてよいと返す", async () => {
    const { status, json } = await call(handleWorkerClaim, "POST", { host: "subpc", job: "weather-sync" }, INGEST);
    assert.equal(status, 200);
    assert.equal(json["run"], true);
    assert.equal(json["owner"], "subpc");
  });

  it("予備（macmini）には担当外と返す", async () => {
    await call(handleWorkerClaim, "POST", { host: "subpc", job: "weather-sync" }, INGEST);
    const { json } = await call(handleWorkerClaim, "POST", { host: "macmini", job: "weather-sync" }, INGEST);
    assert.equal(json["run"], false);
  });

  it("他のシークレットや無認証は401", async () => {
    for (const token of [null, STATUS, CONTROL]) {
      const { status } = await call(handleWorkerClaim, "POST", { host: "subpc", job: "weather-sync" }, token);
      assert.equal(status, 401);
    }
  });

  it("未知のホスト・ジョブは400", async () => {
    assert.equal((await call(handleWorkerClaim, "POST", { host: "vps", job: "weather-sync" }, INGEST)).status, 400);
    assert.equal((await call(handleWorkerClaim, "POST", { host: "subpc", job: "nope" }, INGEST)).status, 400);
  });
});

describe("/api/worker/assignment", () => {
  it("GET は動作状況のシークレットでも切り替えのシークレットでも読める", async () => {
    for (const token of [STATUS, CONTROL]) {
      const { status, json } = await call(handleWorkerAssignment, "GET", undefined, token);
      assert.equal(status, 200);
      assert.equal(json["mode"], "auto");
      assert.ok(Array.isArray(json["hosts"]));
    }
    assert.equal((await call(handleWorkerAssignment, "GET", undefined, INGEST)).status, 401);
  });

  it("POST は切り替えのシークレットだけが通り、固定すると担当が移る", async () => {
    for (const token of [null, STATUS, INGEST]) {
      assert.equal((await call(handleWorkerAssignment, "POST", { mode: "macmini" }, token)).status, 401);
    }
    const { status, json } = await call(handleWorkerAssignment, "POST", { mode: "macmini" }, CONTROL);
    assert.equal(status, 200);
    assert.equal(json["owner"], "macmini");
    assert.equal((json["lastSwitch"] as { reason: string }).reason, "manual");

    const claimed = await call(handleWorkerClaim, "POST", { host: "macmini", job: "zaim-sync" }, INGEST);
    assert.equal(claimed.json["run"], true);
    assert.equal((claimed.json["notice"] as { to: string }).to, "macmini");
  });

  it("不正なモードは400", async () => {
    assert.equal((await call(handleWorkerAssignment, "POST", { mode: "vps" }, CONTROL)).status, 400);
  });

  it("切り替えのシークレットが未設定なら POST は503", async () => {
    delete process.env["AIDE_WORKER_CONTROL_SECRET"];
    try {
      assert.equal((await call(handleWorkerAssignment, "POST", { mode: "auto" }, CONTROL)).status, 503);
    } finally {
      process.env["AIDE_WORKER_CONTROL_SECRET"] = CONTROL;
    }
  });
});
