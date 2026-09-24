import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, describe, it } from "node:test";

const dir = await mkdtemp(join(tmpdir(), "aide-mobile-push-"));
process.env["AIDE_MOBILE_TOKEN_PATH"] = join(dir, "mobile-tokens.json");
process.env["AIDE_PUSH_DEVICES_PATH"] = join(dir, "push-devices.json");
const { handleMobilePushDevices } = await import("./mobile.ts");
const { issueMobileToken } = await import("../auth/mobile-token.ts");
const { listDevices, upsertDevice } = await import("../core/push/devices.ts");
const { buildPayload, isSafePath, sendPush } = await import("../core/push/send.ts");
const { createApnsJwt, loadApnsConfig, isDeadToken } = await import("../core/push/apns.ts");

const options = {
  authConfig: { enabled: true, password: "x" },
  supabase: { allowedEmails: ["me@example.com"] },
} as unknown as Parameters<typeof handleMobilePushDevices>[2];

const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);

function call(init: { method: string; authorization?: string; body?: string }): Promise<{ status: number }> {
  const headers: Record<string, string> = {};
  if (init.authorization) headers["authorization"] = init.authorization;
  const req = Object.assign(Readable.from(init.body ? [Buffer.from(init.body)] : []), {
    method: init.method,
    headers,
  }) as unknown as IncomingMessage;
  return new Promise((resolve) => {
    const res = {
      writeHead(code: number) { (res as { code?: number }).code = code; return res; },
      end() { resolve({ status: (res as { code?: number }).code ?? 0 }); return res; },
    };
    void handleMobilePushDevices(req, res as unknown as ServerResponse, options);
  });
}

after(() => rm(dir, { recursive: true, force: true }));

describe("/api/mobile/push/devices", () => {
  it("認証なし・不正なトークンは401", async () => {
    const body = JSON.stringify({ deviceToken: TOKEN_A, environment: "development" });
    assert.equal((await call({ method: "PUT", body })).status, 401);
    assert.equal((await call({ method: "PUT", body, authorization: "Bearer nope" })).status, 401);
    assert.equal((await call({ method: "DELETE", body })).status, 401);
    assert.equal((await listDevices()).length, 0);
  });

  it("登録・再登録（更新）・失効ができ、未登録の失効も204", async () => {
    const { token } = await issueMobileToken("me@example.com");
    const authorization = `Bearer ${token}`;
    const put = (b: unknown) => call({ method: "PUT", authorization, body: JSON.stringify(b) });

    assert.equal((await put({ deviceToken: TOKEN_A.toUpperCase(), environment: "development" })).status, 204);
    assert.equal((await put({ deviceToken: TOKEN_A, environment: "production", preferences: { test: false } })).status, 204);
    let devices = await listDevices();
    assert.equal(devices.length, 1);
    assert.equal(devices[0]?.environment, "production");
    assert.deepEqual(devices[0]?.preferences, { test: false });

    const del = (b: unknown) => call({ method: "DELETE", authorization, body: JSON.stringify(b) });
    assert.equal((await del({ deviceToken: TOKEN_A })).status, 204);
    assert.equal((await del({ deviceToken: TOKEN_B })).status, 204);
    devices = await listDevices();
    assert.equal(devices.length, 0);
  });

  it("不正な入力は400", async () => {
    const { token } = await issueMobileToken("me@example.com");
    const authorization = `Bearer ${token}`;
    const put = (b: string) => call({ method: "PUT", authorization, body: b });
    assert.equal((await put("not json")).status, 400);
    assert.equal((await put(JSON.stringify({ deviceToken: "zz", environment: "development" }))).status, 400);
    assert.equal((await put(JSON.stringify({ deviceToken: TOKEN_A, environment: "staging" }))).status, 400);
    assert.equal((await put(JSON.stringify({ deviceToken: TOKEN_A, environment: "production", preferences: { test: "yes" } }))).status, 400);
    assert.equal((await call({ method: "GET", authorization })).status, 405);
  });
});

describe("ペイロードと送信", () => {
  it("ペイロードは契約どおりで、本文は固定文", () => {
    assert.deepEqual(buildPayload("test", "/map"), {
      aps: { alert: { title: "AIDE", body: "テスト通知です" }, sound: "default" },
      kind: "test",
      path: "/map",
    });
  });

  it("pathはAIDE内の相対パスだけ", () => {
    assert.ok(isSafePath("/map"));
    assert.ok(isSafePath("/status?tab=1"));
    for (const bad of ["map", "//evil.example", "https://evil.example", "/a b", "", 1]) assert.equal(isSafePath(bad), false);
    assert.throws(() => buildPayload("test", "//evil.example"));
  });

  it("鍵が不正でも例外を外へ出さず、全件を失敗として数える", async () => {
    await upsertDevice({ deviceToken: TOKEN_A, environment: "development", preferences: {} });
    await upsertDevice({ deviceToken: TOKEN_B, environment: "production", preferences: {} });
    const dead = "c".repeat(64);
    const off = "d".repeat(64);
    const ok = "e".repeat(64);
    await upsertDevice({ deviceToken: dead, environment: "production", preferences: {} });
    await upsertDevice({ deviceToken: off, environment: "production", preferences: { test: false } });
    await upsertDevice({ deviceToken: ok, environment: "production", preferences: {} });

    const seen: string[] = [];
    const summary = await sendPush("test", "/map", {
      config: { key: "unused", keyId: "K", teamId: "T", bundleId: "com.example" },
      transport: async (_env, token) => {
        seen.push(token);
        return { status: 200, reason: null };
      },
    });
    assert.equal(summary.failed, 4);
    assert.equal(seen.length, 0);
  });

  it("有効な鍵なら送信され、410/BadDeviceTokenだけ登録簿から消える", async () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const summary = await sendPush("test", "/map", {
      config: { key: pem, keyId: "K", teamId: "T", bundleId: "com.example" },
      transport: async (_env, token, headers) => {
        assert.match(headers["authorization"] ?? "", /^bearer /);
        assert.equal(headers["apns-topic"], "com.example");
        if (token === TOKEN_A) return { status: 410, reason: "Unregistered" };
        if (token === TOKEN_B) return { status: 400, reason: "BadDeviceToken" };
        if (token === "c".repeat(64)) return { status: 500, reason: "InternalServerError" };
        return { status: 200, reason: null };
      },
    });
    assert.deepEqual(summary, { configured: true, sent: 1, failed: 1, removed: 2, skipped: 1 });
    const left = (await listDevices()).map((d) => d.deviceToken).sort();
    assert.deepEqual(left, ["c".repeat(64), "d".repeat(64), "e".repeat(64)]);
  });

  it("APNs設定が無ければ送らず configured:false", async () => {
    const summary = await sendPush("test", "/map", { config: null });
    assert.equal(summary.configured, false);
    assert.equal(loadApnsConfig({}), null);
    assert.equal(loadApnsConfig({ AIDE_APNS_KEY: "k\\nk", AIDE_APNS_KEY_ID: "K", AIDE_APNS_TEAM_ID: "T" })?.bundleId, "com.gucchii.AIDEios");
  });

  it("JWTはES256（r||s）で署名され、公開鍵で検証できる", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwt = createApnsJwt({ keyId: "KID", teamId: "TEAM" }, privateKey, 1000);
    const [h, c, s] = jwt.split(".") as [string, string, string];
    assert.deepEqual(JSON.parse(Buffer.from(h, "base64url").toString()), { alg: "ES256", kid: "KID" });
    assert.deepEqual(JSON.parse(Buffer.from(c, "base64url").toString()), { iss: "TEAM", iat: 1000 });
    assert.ok(verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")));
    assert.ok(isDeadToken({ status: 410, reason: "Unregistered" }));
    assert.equal(isDeadToken({ status: 400, reason: "PayloadEmpty" }), false);
  });
});
