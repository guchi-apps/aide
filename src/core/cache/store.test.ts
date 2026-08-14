import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// 本番のキャッシュを汚さないよう、読み込み前に置き場を一時ディレクトリへ差し替える。
// CACHE_DIR はモジュール読み込み時に確定するため、import より前に設定する必要がある。
process.env["AIDE_CACHE_DIR"] = await mkdtemp(join(tmpdir(), "aide-cache-test-"));
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
