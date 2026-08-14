import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// CACHE_DIR はモジュール定数なので、テストでは pathFor を通さず
// 公開APIの振る舞い（往復・不在・キー検証）だけを確認する。
const { readCache, writeCache } = await import("./store.ts");

describe("キャッシュ", () => {
  it("書いた値をそのまま読み戻せる", async () => {
    await writeCache("test-roundtrip", "unit", { hello: "world" });
    const got = await readCache<{ hello: string }>("test-roundtrip");
    assert.equal(got?.data.hello, "world");
    assert.equal(got?.source, "unit");
    assert.ok(got && got.ageMinutes >= 0);
  });

  it("存在しないキーは null を返す", async () => {
    assert.equal(await readCache("test-missing-key-xyz"), null);
  });

  it("パス区切りを含むキーを拒否する", async () => {
    await assert.rejects(() => writeCache("../escape", "unit", {}), /不正なキャッシュキー/);
    await assert.rejects(() => writeCache("a/b", "unit", {}), /不正なキャッシュキー/);
  });

  it("取得時刻が記録される", async () => {
    await writeCache("test-fetched-at", "unit", 1);
    const got = await readCache<number>("test-fetched-at");
    assert.ok(got);
    assert.ok(!Number.isNaN(new Date(got.fetchedAt).getTime()));
  });
});
