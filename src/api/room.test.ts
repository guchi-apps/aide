import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthConfig } from "../auth/config.ts";
import type { RoomSensorSummary, RoomStatus } from "../core/views/room.ts";
import { ToolRegistry } from "../mcp/registry.ts";
import type { LoginOptions } from "../web/login.ts";
import { handleRoomSummary, pickSensor, type RoomSummaryDeps } from "./room.ts";

function sensor(overrides: Partial<RoomSensorSummary> = {}): RoomSensorSummary {
  return {
    deviceId: 1,
    name: "リビング",
    measuredAt: "2026-09-24T00:38:00.000Z",
    ageMinutes: 3,
    stale: false,
    temperature: 26.4,
    humidity: 52,
    pressure: 1010,
    co2: 700,
    illuminance: 100,
    outdoorDeltaCelsius: 3.1,
    ...overrides,
  };
}

function status(sensors: RoomSensorSummary[]): RoomStatus {
  return {
    checkedAt: "2026-09-24T00:40:00.000Z",
    configured: true,
    ok: true,
    severity: "ok",
    complete: true,
    problems: [],
    measuredAt: "2026-09-24T00:39:00.000Z",
    staleThresholdMinutes: 30,
    sensors,
    outdoor: null,
    aircons: [],
    unavailable: [],
    note: "",
  };
}

function call(deps: RoomSummaryDeps, method = "GET") {
  const captured = { status: 0, headers: {} as Record<string, string | string[]>, body: "" };
  const res = {
    writeHead(s: number, h?: Record<string, string | string[]>) {
      captured.status = s;
      captured.headers = h ?? {};
      return res;
    },
    end(b?: string) {
      captured.body = b ?? "";
      return res;
    },
  } as unknown as ServerResponse;
  const req = { url: "/api/room/summary", method, headers: {} } as unknown as IncomingMessage;
  const authConfig: AuthConfig = { enabled: true, password: "x" };
  const options: LoginOptions = { authConfig, supabase: null, baseUrl: "http://localhost", registry: new ToolRegistry() };
  return handleRoomSummary(req, res, options, deps).then(() => captured);
}

const loggedIn = async () => ({ email: "a@example.com" });

describe("pickSensor", () => {
  it("受信が止まっていないセンサーを優先する", () => {
    const picked = pickSensor([sensor({ name: "止まっている", stale: true }), sensor({ name: "書斎" })]);
    assert.equal(picked?.name, "書斎");
  });

  it("室温が取れているセンサーがなければ null", () => {
    assert.equal(pickSensor([sensor({ temperature: null }), sensor({ stale: true })]), null);
    assert.equal(pickSensor([]), null);
  });
});

describe("GET /api/room/summary", () => {
  it("未ログインは401のJSONで、リダイレクトしない", async () => {
    const r = await call({ currentSession: async () => null, buildRoomStatus: async () => status([sensor()]) });
    assert.equal(r.status, 401);
    assert.equal(r.headers["Location"], undefined);
    assert.deepEqual(JSON.parse(r.body), { error: "unauthorized" });
  });

  it("1台分の値を約束の形で返す", async () => {
    const r = await call({ currentSession: loggedIn, buildRoomStatus: async () => status([sensor()]) });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), {
      name: "リビング",
      temperature: 26.4,
      humidity: 52,
      outdoorDeltaCelsius: 3.1,
      measuredAt: "2026-09-24T00:38:00.000Z",
    });
  });

  it("値が取れないときは503で、最終測定時刻を必ず含める", async () => {
    const r = await call({
      currentSession: loggedIn,
      buildRoomStatus: async () => status([sensor({ stale: true, measuredAt: "2026-09-20T00:00:00.000Z" })]),
    });
    assert.equal(r.status, 503);
    assert.equal(JSON.parse(r.body).measuredAt, "2026-09-20T00:00:00.000Z");
  });

  it("取得自体ができないときも503で、measuredAt を null で含める", async () => {
    const r = await call({ currentSession: loggedIn, buildRoomStatus: async () => ({ ...status([]), measuredAt: null }) });
    assert.equal(r.status, 503);
    assert.ok("measuredAt" in JSON.parse(r.body));
    assert.equal(JSON.parse(r.body).measuredAt, null);
  });

  it("GET / HEAD 以外は405", async () => {
    const r = await call({ currentSession: loggedIn }, "POST");
    assert.equal(r.status, 405);
  });
});
