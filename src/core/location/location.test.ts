import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createLocationStore } from "./store.ts";
import { FRESH_MS, RETENTION_MS } from "./types.ts";
import { parseLocation } from "./validate.ts";

const NOW = new Date("2026-11-01T03:00:00Z");
const base = { latitude: 35.0, longitude: 135.0, horizontalAccuracyM: 20, measuredAt: "2026-11-01T02:59:00Z" };
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), "aide-loc-"));
  const path = join(dir, "location.json");
  return { path, store: createLocationStore(path) };
}

describe("parseLocation", () => {
  it("正しい値を受ける", () => {
    assert.equal(parseLocation(base, NOW).ok, true);
  });
  it("範囲外・型違い・未知の項目を拒否する", () => {
    for (const bad of [
      { ...base, latitude: 91 },
      { ...base, longitude: -181 },
      { ...base, latitude: "35" },
      { ...base, horizontalAccuracyM: -1 },
      { ...base, horizontalAccuracyM: 1e9 },
      { ...base, extra: 1 },
      { ...base, measuredAt: "2026-11-01T02:59:00" },
      { ...base, measuredAt: "bad" },
    ]) assert.equal(parseLocation(bad, NOW).ok, false);
    assert.equal(parseLocation(null, NOW).ok, false);
  });
  it("未来・著しく古い測位時刻を拒否し、時計ずれの少しの未来は許す", () => {
    assert.equal(parseLocation({ ...base, measuredAt: at(10 * 60_000) }, NOW).ok, false);
    assert.equal(parseLocation({ ...base, measuredAt: at(60_000) }, NOW).ok, true);
    assert.equal(parseLocation({ ...base, measuredAt: at(-RETENTION_MS - 1000) }, NOW).ok, false);
  });
  it("拒否理由に座標の値を含めない", () => {
    const r = parseLocation({ ...base, latitude: 123.456789 }, NOW);
    assert.ok(!r.ok && !r.reason.includes("123.456789"));
  });
});

describe("LocationStore", () => {
  it("有効化前は not_enabled、受信前は no_location", async () => {
    const { store } = await tempStore();
    assert.deepEqual(await store.current(NOW), { status: "unavailable", reason: "not_enabled" });
    await store.enable(NOW);
    assert.deepEqual(await store.current(NOW), { status: "unavailable", reason: "no_location" });
  });
  it("トークンはハッシュだけ保存し、別のトークンは認証できない", async () => {
    const { store, path } = await tempStore();
    const { token, deviceId } = await store.enable(NOW);
    assert.equal(await store.authenticate(token), deviceId);
    assert.equal(await store.authenticate(token + "x"), null);
    assert.equal(await store.authenticate(""), null);
    assert.ok(!(await readFile(path, "utf8")).includes(token));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });
  it("再有効化で古いトークンと保存位置が失効する", async () => {
    const { store } = await tempStore();
    const first = await store.enable(NOW);
    await store.submit(parseOk(base), NOW);
    const second = await store.enable(NOW);
    assert.equal(await store.authenticate(first.token), null);
    assert.equal(await store.authenticate(second.token) !== null, true);
    assert.equal((await store.current(NOW)).status, "unavailable");
  });
  it("測位時刻の新しいものだけ適用し、重複・逆転は無視する", async () => {
    const { store } = await tempStore();
    await store.enable(NOW);
    assert.deepEqual(await store.submit(parseOk(base), NOW), { ok: true, applied: true });
    assert.deepEqual(await store.submit(parseOk(base), NOW), { ok: true, applied: false, reason: "duplicate" });
    const older = { ...base, latitude: 10, measuredAt: "2026-11-01T02:58:00Z" };
    assert.deepEqual(await store.submit(parseOk(older), NOW), { ok: true, applied: false, reason: "older" });
    const newer = { ...base, latitude: 36, measuredAt: "2026-11-01T02:59:30Z" };
    assert.equal((await store.submit(parseOk(newer), NOW)).applied, true);
    const cur = await store.current(NOW);
    assert.ok(cur.status === "fresh" && cur.location.latitude === 36);
  });
  it("鮮度: fresh → stale → 期限切れで座標を返さず削除", async () => {
    const { store, path } = await tempStore();
    await store.enable(NOW);
    await store.submit(parseOk(base), NOW);
    assert.equal((await store.current(NOW)).status, "fresh");
    assert.equal((await store.current(new Date(NOW.getTime() + FRESH_MS + 60_000))).status, "stale");
    const later = new Date(NOW.getTime() + RETENTION_MS + 120_000);
    assert.deepEqual(await store.current(later), { status: "unavailable", reason: "expired" });
    assert.ok(!(await readFile(path, "utf8")).includes("35"));
  });
  it("disable でファイルごと消え、座標が残らず、トークンも失効する", async () => {
    const { store, path } = await tempStore();
    const { token } = await store.enable(NOW);
    await store.submit(parseOk(base), NOW);
    assert.deepEqual(await store.disable(), { wasEnabled: true });
    await assert.rejects(stat(path));
    assert.equal(await store.authenticate(token), null);
    assert.deepEqual(await store.current(NOW), { status: "unavailable", reason: "not_enabled" });
  });
});

function parseOk(raw: unknown) {
  const r = parseLocation(raw, NOW);
  assert.ok(r.ok);
  return r.input;
}
