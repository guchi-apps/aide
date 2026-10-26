import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createLocationStore } from "../../core/location/store.ts";
import { buildToolRegistry } from "../catalog.ts";
import { parseSupportedScopes } from "../../auth/oauth.ts";
import { createCurrentLocationTool } from "./location.ts";

const NOW = new Date("2026-11-01T03:00:00Z");
const input = { latitude: 35.1, longitude: 135.2, horizontalAccuracyM: 10, measuredAt: "2026-11-01T02:59:00.000Z" };

async function setup() {
  const store = createLocationStore(join(await mkdtemp(join(tmpdir(), "aide-loctool-")), "l.json"));
  return { store, tool: createCurrentLocationTool(() => store, () => NOW) };
}
const run = async (tool: ReturnType<typeof createCurrentLocationTool>) =>
  JSON.parse((await tool.handler({}, { sessionId: null })).content[0]!.text) as Record<string, unknown>;

describe("aide_current_location", () => {
  it("専用scopeを要求し、読み取り専用で登録されている", () => {
    assert.deepEqual(createCurrentLocationTool().requiredScopes, ["location:read"]);
    assert.ok(buildToolRegistry().list().some((t) => t.name === "aide_current_location"));
  });
  it("location:read は要求されたときだけ付与対象になり、他のscopeに巻き込まれない", () => {
    assert.deepEqual(parseSupportedScopes("tasks:read"), ["tasks:read"]);
    assert.deepEqual(parseSupportedScopes("location:read"), ["location:read"]);
  });
  it("未共有・未受信は座標を返さず理由を示す", async () => {
    const { store, tool } = await setup();
    const off = await run(tool);
    assert.equal(off["status"], "unavailable");
    assert.equal(off["reason"], "not_enabled");
    assert.ok(!("latitude" in off));
    await store.enable(NOW);
    assert.equal((await run(tool))["reason"], "no_location");
  });
  it("fresh は座標・精度・両時刻・経過秒を返す", async () => {
    const { store, tool } = await setup();
    await store.enable(NOW);
    await store.submit(input, NOW);
    const r = await run(tool);
    assert.equal(r["status"], "fresh");
    assert.equal(r["latitude"], 35.1);
    assert.equal(r["horizontalAccuracyM"], 10);
    assert.equal(r["measuredAt"], input.measuredAt);
    assert.equal(r["ageSeconds"], 60);
    assert.ok(typeof r["receivedAt"] === "string");
  });
  it("停止後は座標を返さない", async () => {
    const { store, tool } = await setup();
    await store.enable(NOW);
    await store.submit(input, NOW);
    await store.disable();
    const r = await run(tool);
    assert.equal(r["status"], "unavailable");
    assert.ok(!("latitude" in r));
  });
});
