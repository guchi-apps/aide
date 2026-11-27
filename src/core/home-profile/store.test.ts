import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHomeProfileStore, validateHomeProfile, type HomeProfileInput } from "./store.ts";

async function tempPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "aide-home-")), "home-profile.json");
}

function input(raw: Record<string, unknown>): HomeProfileInput {
  const validated = validateHomeProfile(raw);
  assert.ok(validated.ok);
  return validated.input;
}

test("ファイルが無ければ未設定で、初期値を作らない", async () => {
  const path = await tempPath();
  assert.equal(await createHomeProfileStore(path).read(), null);
  await assert.rejects(readFile(path), { code: "ENOENT" });
});

test("保存すると版と更新時刻が付き、0600で書く。区間は優先順に並ぶ", async () => {
  const path = await tempPath();
  const store = createHomeProfileStore(path);
  const route = { mode: "WALK", typicalMinutes: 10 };
  const outcome = await store.save(
    input({ accessRoutes: [{ ...route, to: "B駅", priority: 2 }, { ...route, to: "A駅", priority: 1 }] }),
    0,
    new Date("2026-11-27T00:00:00Z"),
  );
  assert.ok(outcome.ok);
  const saved = await store.read();
  assert.equal(saved?.version, 1);
  assert.equal(saved?.label, "自宅");
  assert.equal(saved?.updatedAt, "2026-11-27T00:00:00.000Z");
  assert.deepEqual(saved?.accessRoutes.map((r) => r.to), ["A駅", "B駅"]);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("古い版での保存は上書きせず、中身を空にすると未設定へ戻る", async () => {
  const store = createHomeProfileStore(await tempPath());
  await store.save(input({ area: { city: "テスト市" } }), 0);
  assert.deepEqual(await store.save(input({ area: { city: "別の市" } }), 0), { ok: false, reason: "conflict" });
  assert.equal((await store.read())?.area.city, "テスト市");

  assert.deepEqual(await store.save(input({ label: "自宅" }), 1), { ok: true, profile: null });
  assert.equal(await store.read(), null);
});

test("壊れたファイルは例外にして上書きせず、例外に中身を含めない", async () => {
  const path = await tempPath();
  await writeFile(path, '{"exactAddress":"秘密の住所1-2-3"', "utf8");
  const store = createHomeProfileStore(path);
  const hidesContent = (error: Error) => !error.message.includes("秘密");
  await assert.rejects(store.read(), hidesContent);
  await assert.rejects(store.save(input({ area: { city: "テスト市" } }), 0), hidesContent);
  assert.match(await readFile(path, "utf8"), /秘密の住所/);
});

test("範囲外の値と欠けた区間は弾く", () => {
  const validated = validateHomeProfile({
    area: { postalCode: "12" },
    coordinates: { latitude: 100, longitude: 0 },
    accessRoutes: [{ to: "A駅", mode: "TRAIN" }],
    departurePreferences: { rainExtraMinutes: -1 },
  });
  assert.ok(!validated.ok);
  assert.equal(validated.errors.length, 5);
});
