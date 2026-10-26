import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { resetRateLimits } from "../auth/ratelimit.ts";
import { createLocationStore } from "../core/location/store.ts";
import { handleLocation, resetLocationRateForTest } from "./location.ts";

const NOW = new Date("2026-11-01T03:00:00Z");
const body = { latitude: 35.1, longitude: 135.2, horizontalAccuracyM: 10, measuredAt: "2026-11-01T02:59:00Z" };

function request(url: string, opts: { auth?: string; json?: unknown; raw?: string; type?: string | null } = {}): IncomingMessage {
  const text = opts.raw ?? (opts.json !== undefined ? JSON.stringify(opts.json) : "");
  const req = new EventEmitter() as unknown as IncomingMessage & { [Symbol.asyncIterator]: () => AsyncGenerator<Buffer> };
  Object.assign(req, {
    method: "POST",
    url,
    headers: {
      ...(opts.auth ? { authorization: `Bearer ${opts.auth}` } : {}),
      ...(opts.type === null ? {} : { "content-type": opts.type ?? "application/json" }),
    },
    socket: { remoteAddress: "127.0.0.1" },
    resume() {},
    async *[Symbol.asyncIterator]() {
      if (text) yield Buffer.from(text);
    },
  });
  return req;
}

function response() {
  const out = { status: 0, body: "" };
  const res = {
    headersSent: false,
    writeHead(status: number) {
      out.status = status;
      return res;
    },
    end(text?: string) {
      out.body = text ?? "";
      res.headersSent = true;
    },
  };
  return { res: res as unknown as ServerResponse, out };
}

async function setup(session = false) {
  const store = createLocationStore(join(await mkdtemp(join(tmpdir(), "aide-locapi-")), "l.json"));
  const deps = { store, now: () => NOW, hasSession: async () => session };
  return { store, deps };
}

async function call(deps: Parameters<typeof handleLocation>[2], url: string, opts?: Parameters<typeof request>[1]) {
  const { res, out } = response();
  await handleLocation(request(url, opts), res, deps);
  return { status: out.status, json: out.body ? (JSON.parse(out.body) as Record<string, unknown>) : {} };
}

beforeEach(() => {
  resetRateLimits();
  resetLocationRateForTest();
});

describe("POST /api/location", () => {
  it("匿名・誤ったトークン・共有オフでは401で何も保存しない", async () => {
    const { store, deps } = await setup();
    assert.equal((await call(deps, "/api/location", { json: body })).status, 401);
    assert.equal((await call(deps, "/api/location", { auth: "aloc_x", json: body })).status, 401);
    await store.enable(NOW);
    assert.equal((await call(deps, "/api/location", { auth: "aloc_wrong", json: body })).status, 401);
    assert.equal((await store.current(NOW)).status, "unavailable");
  });

  it("端末トークンで受理し、重複・逆転は200で applied:false", async () => {
    const { store, deps } = await setup();
    const { token } = await store.enable(NOW);
    assert.deepEqual((await call(deps, "/api/location", { auth: token, json: body })).json, { ok: true, applied: true });
    assert.equal((await call(deps, "/api/location", { auth: token, json: body })).json["reason"], "duplicate");
    const older = { ...body, measuredAt: "2026-11-01T02:50:00Z" };
    assert.equal((await call(deps, "/api/location", { auth: token, json: older })).json["reason"], "older");
    assert.equal((await store.current(NOW)).status, "fresh");
  });

  it("不正値は400（理由に座標を含めない）、未来時刻も拒否", async () => {
    const { store, deps } = await setup();
    const { token } = await store.enable(NOW);
    const bad = await call(deps, "/api/location", { auth: token, json: { ...body, latitude: 999.123 } });
    assert.equal(bad.status, 400);
    assert.ok(!JSON.stringify(bad.json).includes("999.123"));
    assert.equal((await call(deps, "/api/location", { auth: token, json: { ...body, measuredAt: "2026-11-02T00:00:00Z" } })).status, 400);
    assert.equal((await call(deps, "/api/location", { auth: token, raw: "{" })).status, 400);
  });

  it("本文が上限を超えたら413、JSON以外は415", async () => {
    const { store, deps } = await setup();
    const { token } = await store.enable(NOW);
    assert.equal((await call(deps, "/api/location", { auth: token, raw: JSON.stringify({ pad: "x".repeat(3000) }) })).status, 413);
    assert.equal((await call(deps, "/api/location", { auth: token, json: body, type: "text/plain" })).status, 415);
  });

  it("1分あたりの回数を超えたら429", async () => {
    const { store, deps } = await setup();
    const { token } = await store.enable(NOW);
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await call(deps, "/api/location", { auth: token, json: body })).status;
    assert.equal(last, 429);
  });
});

describe("enable / disable", () => {
  it("enable は画面ログインのセッションが要り、トークンを返す", async () => {
    const anon = await setup(false);
    assert.equal((await call(anon.deps, "/api/location/enable", { json: {} })).status, 401);
    const { deps } = await setup(true);
    const r = await call(deps, "/api/location/enable", { json: {} });
    assert.equal(r.status, 200);
    assert.match(String(r.json["token"]), /^aloc_/);
    assert.equal((await call(deps, "/api/location/enable", { json: {}, type: "text/plain" })).status, 415);
  });

  it("disable で保存位置を削除し、トークンは使えなくなる", async () => {
    const { store, deps } = await setup(false);
    const { token } = await store.enable(NOW);
    await call(deps, "/api/location", { auth: token, json: body });
    assert.equal((await call(deps, "/api/location/disable", { json: {} })).status, 401);
    assert.equal((await call(deps, "/api/location/disable", { auth: token, json: {} })).status, 200);
    assert.equal((await call(deps, "/api/location", { auth: token, json: body })).status, 401);
    assert.deepEqual(await store.current(NOW), { status: "unavailable", reason: "not_enabled" });
  });
});
