import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import type { RoomSensorSummary, RoomStatus } from "../core/views/room.ts";

const dir = await mkdtemp(join(tmpdir(), "aide-mobile-api-"));
process.env["AIDE_MOBILE_TOKEN_PATH"] = join(dir, "mobile-tokens.json");
const { handleMobileRoomTemperature, handleMobileToken, pickRoomTemperature } = await import("./mobile.ts");
const { issueMobileToken } = await import("../auth/mobile-token.ts");
const { issueAppHandoff, resetAppHandoffs } = await import("../web/app-auth.ts");

const VERIFIER = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~".slice(0, 64);
const CHALLENGE = createHash("sha256").update(VERIFIER, "ascii").digest("base64url");

const options = {
  authConfig: { enabled: true, password: "x" },
  supabase: { allowedEmails: ["me@example.com"] },
} as unknown as Parameters<typeof handleMobileToken>[2];

function sensor(overrides: Partial<RoomSensorSummary>): RoomSensorSummary {
  return {
    deviceId: 1, name: "リビング", measuredAt: "2026-09-24T01:00:00Z", ageMinutes: 1, stale: false,
    temperature: 24.5, humidity: null, pressure: null, co2: null, illuminance: null,
    outdoorDeltaCelsius: null, ...overrides,
  };
}

function status(sensors: RoomSensorSummary[], overrides: Partial<RoomStatus> = {}): RoomStatus {
  return { configured: true, complete: true, sensors, ...overrides } as RoomStatus;
}

function call(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  init: { method?: string; authorization?: string; body?: string } = {},
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = {};
  if (init.authorization) headers["authorization"] = init.authorization;
  const req = Object.assign(Readable.from(init.body ? [Buffer.from(init.body)] : []), {
    method: init.method ?? "GET",
    headers,
  }) as unknown as IncomingMessage;
  return new Promise((resolve) => {
    const out = { status: 0, body: "" };
    const res = {
      writeHead(code: number) { out.status = code; return res; },
      end(body?: string) { out.body = body ?? ""; resolve(out); return res; },
    };
    void handler(req, res as unknown as ServerResponse);
  });
}

afterEach(() => {
  delete process.env["AIDE_MOBILE_ROOM_SENSOR"];
  resetAppHandoffs();
});
after(() => rm(dir, { recursive: true, force: true }));

describe("pickRoomTemperature", () => {
  it("受信が止まっていない最初のセンサーを選ぶ", () => {
    const picked = pickRoomTemperature(
      [sensor({ name: "古い", stale: true }), sensor({ deviceId: 2, name: "寝室", temperature: 22 })],
      null,
    );
    assert.deepEqual(picked, { sensorName: "寝室", temperature: 22, measuredAt: "2026-09-24T01:00:00Z", stale: false });
  });

  it("全部staleなら最初の温度ありセンサーをstaleで返す", () => {
    const picked = pickRoomTemperature([sensor({ temperature: null }), sensor({ deviceId: 2, stale: true })], null);
    assert.equal(picked?.stale, true);
    assert.equal(picked?.temperature, 24.5);
  });

  it("指定は名前でもdeviceIdでもよく、見つからなければ別のセンサーで代えない", () => {
    const sensors = [sensor({}), sensor({ deviceId: 2, name: "寝室", temperature: 22 })];
    assert.equal(pickRoomTemperature(sensors, "寝室")?.temperature, 22);
    assert.equal(pickRoomTemperature(sensors, "2")?.sensorName, "寝室");
    assert.equal(pickRoomTemperature(sensors, "書斎"), null);
  });

  it("温度が1つも無ければ null", () => {
    assert.equal(pickRoomTemperature([sensor({ temperature: null })], null), null);
  });
});

describe("GET /api/mobile/room-temperature", () => {
  const load = (s: RoomStatus) => async () => s;
  const get = (authorization: string | undefined, s: RoomStatus) =>
    call((req, res) => handleMobileRoomTemperature(req, res, options, load(s)), { authorization });

  it("認証なし・不正なトークンは401", async () => {
    assert.equal((await get(undefined, status([sensor({})]))).status, 401);
    assert.equal((await get("Bearer wrong", status([sensor({})]))).status, 401);
  });

  it("有効なトークンなら室温を返す", async () => {
    const { token } = await issueMobileToken("me@example.com");
    const r = await get(`Bearer ${token}`, status([sensor({})]));
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), {
      sensorName: "リビング", temperature: 24.5, measuredAt: "2026-09-24T01:00:00Z", stale: false,
    });
  });

  it("許可リストから外れたメールのトークンは401", async () => {
    const { token } = await issueMobileToken("other@example.com");
    assert.equal((await get(`Bearer ${token}`, status([sensor({})]))).status, 401);
  });

  it("myroomを取得できなければ503、室温にできるセンサーが無ければ502", async () => {
    const { token } = await issueMobileToken("me@example.com");
    assert.equal((await get(`Bearer ${token}`, status([], { complete: false }))).status, 503);
    assert.equal((await get(`Bearer ${token}`, status([sensor({ temperature: null })]))).status, 502);
  });

  it("GET以外は405", async () => {
    const r = await call((req, res) => handleMobileRoomTemperature(req, res, options, load(status([]))), { method: "POST" });
    assert.equal(r.status, 405);
  });
});

describe("/api/mobile/token", () => {
  const form = (code: string) => `code=${code}&code_verifier=${VERIFIER}`;
  const exchange = (code: string) =>
    call((req, res) => handleMobileToken(req, res, options), { method: "POST", body: form(code) });

  it("mobile用コードをトークンへ交換でき、そのトークンで室温を読め、失効できる", async () => {
    const code = issueAppHandoff({ email: "me@example.com", next: "/map", challenge: CHALLENGE, purpose: "mobile" });
    const r = await exchange(code);
    assert.equal(r.status, 200);
    const { token, tokenType } = JSON.parse(r.body) as { token: string; tokenType: string };
    assert.equal(tokenType, "Bearer");

    const ok = await call(
      (req, res) => handleMobileRoomTemperature(req, res, options, async () => status([sensor({})])),
      { authorization: `Bearer ${token}` },
    );
    assert.equal(ok.status, 200);

    const del = await call((req, res) => handleMobileToken(req, res, options), { method: "DELETE", authorization: `Bearer ${token}` });
    assert.equal(del.status, 204);
    const after = await call(
      (req, res) => handleMobileRoomTemperature(req, res, options, async () => status([sensor({})])),
      { authorization: `Bearer ${token}` },
    );
    assert.equal(after.status, 401);
  });

  it("Web用コードでは交換できず、コードは二度使えない", async () => {
    const web = issueAppHandoff({ email: "me@example.com", next: "/map", challenge: CHALLENGE });
    assert.equal((await exchange(web)).status, 401);

    const mobile = issueAppHandoff({ email: "me@example.com", next: "/map", challenge: CHALLENGE, purpose: "mobile" });
    assert.equal((await exchange(mobile)).status, 200);
    assert.equal((await exchange(mobile)).status, 401);
  });

  it("許可されていないメールのコードは交換できない", async () => {
    const code = issueAppHandoff({ email: "other@example.com", next: "/map", challenge: CHALLENGE, purpose: "mobile" });
    assert.equal((await exchange(code)).status, 401);
  });

  it("Googleログイン未設定の環境ではトークンを発行しない", async () => {
    const r = await call((req, res) => handleMobileToken(req, res, { ...options, supabase: null }), { method: "POST", body: "" });
    assert.equal(r.status, 404);
  });
});
