import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { normalizeCreateTravelInput } from "../../core/connectors/dayspan/travels.ts";
import { resetSharedTokenCacheForTest } from "../../core/connectors/issue-deck/shared-tokens.ts";
import type { ToolResult } from "../types.ts";
import { createTravelTool, getTravelTool } from "./travels.ts";

const CTX = { sessionId: null };
const originalFetch = globalThis.fetch;

const VALID = {
  origin: "伊丹空港",
  destination: "羽田空港",
  mode: "OTHER",
  departAt: "2026-11-01T09:30:00+09:00",
  arriveAt: "2026-11-01T11:00:00+09:00",
  idempotencyKey: "travel-test-0001",
};

function parse(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

interface Seen { url: string; method: string; headers: Record<string, string>; body: string | undefined }

function stub(status: number, body: unknown, seen: Seen[] = []): void {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, method: init.method ?? "GET", headers: init.headers as Record<string, string>, body: init.body as string | undefined });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

beforeEach(() => {
  process.env["AIDE_DAYSPAN_WRITE_TOKEN"] = "write-secret";
  process.env["AIDE_DAYSPAN_TOKEN"] = "read-secret";
  process.env["AIDE_DAYSPAN_TARGET_EMAIL"] = "me@example.com";
});

afterEach(() => {
  for (const k of ["AIDE_DAYSPAN_WRITE_TOKEN", "AIDE_DAYSPAN_TOKEN", "AIDE_DAYSPAN_TARGET_EMAIL"]) delete process.env[k];
  globalThis.fetch = originalFetch;
  resetSharedTokenCacheForTest();
});

describe("aide_create_travel の宣言", () => {
  it("書込scopeを要求し、読戻しは別の読取scope", () => {
    assert.deepEqual(createTravelTool.requiredScopes, ["travel:write"]);
    assert.deepEqual(getTravelTool.requiredScopes, ["travel:read"]);
  });
  it("aide_create_event へ誘導せず、重複確認と読戻しを説明に書く", () => {
    assert.match(createTravelTool.description, /aide_schedule/);
    assert.match(createTravelTool.description, /aide_get_travel/);
    assert.match(createTravelTool.description, /idempotencyKey/);
  });
});

describe("normalizeCreateTravelInput", () => {
  it("正常な入力を受け付ける", () => {
    const r = normalizeCreateTravelInput({ ...VALID, note: " NH22 " });
    assert.ok("input" in r);
    assert.equal(r.input.note, "NH22");
  });
  for (const [name, patch] of [
    ["タイムゾーン無しの日時", { departAt: "2026-11-01T09:30:00" }],
    ["実在しない日付", { departAt: "2026-02-30T09:30:00+09:00" }],
    ["到着が出発以前", { arriveAt: "2026-11-01T09:30:00+09:00" }],
    ["不正なmode", { mode: "FLIGHT" }],
    ["出発地が空", { origin: " " }],
    ["経由が11件", { via: Array.from({ length: 11 }, () => "x") }],
    ["短すぎる冪等キー", { idempotencyKey: "abc" }],
    ["冪等キー無し", { idempotencyKey: undefined }],
  ] as const) {
    it(`${name}を弾く`, () => {
      assert.ok("error" in normalizeCreateTravelInput({ ...VALID, ...patch }));
    });
  }
});

describe("aide_create_travel の動作", () => {
  it("dryRun はネットワークへ出ない", async () => {
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response("{}"); }) as typeof fetch;
    const p = parse(await createTravelTool.handler({ ...VALID, dryRun: true }, CTX));
    assert.equal(p["dryRun"], true);
    assert.equal(called, false);
  });

  it("書込鍵・対象メール・冪等キーを付けて送り、移動ID・保存・書き出し状態を返す", async () => {
    const seen: Seen[] = [];
    stub(201, { saved: true, travelId: "t1", googleExport: { status: "failed", message: "x" }, replayed: false }, seen);
    const p = parse(await createTravelTool.handler({ ...VALID, note: "NH22 座席12A" }, CTX));
    assert.equal(p["ok"], true);
    assert.equal(p["travelId"], "t1");
    assert.equal(p["saved"], true);
    assert.match(String(p["next"]), /書き出しに失敗/);
    assert.match(String(p["next"]), /読み戻/);
    const req = seen[0]!;
    assert.ok(req.url.endsWith("/api/internal/travels"));
    assert.equal(req.headers["authorization"], "Bearer write-secret");
    assert.equal(req.headers["x-target-email"], "me@example.com");
    assert.equal(req.headers["idempotency-key"], VALID.idempotencyKey);
    assert.equal((JSON.parse(req.body!) as Record<string, unknown>)["idempotencyKey"], undefined);
  });

  it("書込鍵が無ければ何も送らない", async () => {
    delete process.env["AIDE_DAYSPAN_WRITE_TOKEN"];
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response("{}"); }) as typeof fetch;
    const p = parse(await createTravelTool.handler(VALID, CTX));
    assert.equal(p["ok"], false);
    assert.equal(called, false);
  });

  it("重複は existingTravelId を返し、未登録と案内する", async () => {
    stub(409, { error: "duplicate_travel", executed: false, existingTravelId: "t0" });
    const p = parse(await createTravelTool.handler(VALID, CTX));
    assert.equal(p["kind"], "duplicate");
    assert.equal(p["existingTravelId"], "t0");
  });

  it("処理中は同じキーでの再送を案内する", async () => {
    stub(409, { error: "operation_in_progress", executed: "unknown", retryAfterSeconds: 3 });
    const p = parse(await createTravelTool.handler(VALID, CTX));
    assert.equal(p["kind"], "in_progress");
    assert.match(String(p["next"]), /同じ idempotencyKey/);
  });

  it("5xx・接続失敗は結果不明とし、未登録と言い切らない", async () => {
    stub(502, { error: "result_unknown" });
    let p = parse(await createTravelTool.handler(VALID, CTX));
    assert.equal(p["kind"], "result_unknown");
    assert.equal(p["executed"], "unknown");
    globalThis.fetch = (async () => { throw new Error("down"); }) as typeof fetch;
    p = parse(await createTravelTool.handler(VALID, CTX));
    assert.equal(p["kind"], "result_unknown");
    assert.match(String(p["next"]), /作り直さず/);
  });

  it("認証拒否は unauthorized", async () => {
    stub(401, { error: "unauthorized" });
    assert.equal(parse(await createTravelTool.handler(VALID, CTX))["kind"], "unauthorized");
  });
});

describe("aide_get_travel", () => {
  it("読取鍵で移動IDを読み戻す", async () => {
    const seen: Seen[] = [];
    stub(200, { travel: { id: "t1" }, googleExport: { exported: true } }, seen);
    const p = parse(await getTravelTool.handler({ travelId: "t1" }, CTX));
    assert.equal(p["ok"], true);
    assert.equal(seen[0]!.method, "GET");
    assert.equal(seen[0]!.headers["authorization"], "Bearer read-secret");
  });
  it("存在しなければ not_found", async () => {
    stub(404, { error: "travel_not_found" });
    assert.equal(parse(await getTravelTool.handler({ travelId: "x" }, CTX))["kind"], "not_found");
  });
});
