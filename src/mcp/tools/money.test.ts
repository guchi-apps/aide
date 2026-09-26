import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

// キャッシュの置き場を差し替えてから読み込む（本番のキャッシュを汚さない）。
const dir = await mkdtemp(join(tmpdir(), "aide-mcp-money-test-"));
process.env["AIDE_CACHE_DIR"] = join(dir, "cache");
const { writeCache } = await import("../../core/cache/store.ts");
const { ZAIM_CACHE_KEY } = await import("../../worker/jobs/zaim-sync.ts");
const { balancesTool } = await import("./money.ts");

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

function parsed(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe("aide_balances（#489）", () => {
  it("キャッシュが空なら empty: true のまま、staleAccountNames は空配列", async () => {
    const body = parsed(await balancesTool.handler({}, { sessionId: null }));
    assert.equal(body["empty"], true);
    assert.deepEqual(body["staleAccountNames"], []);
    assert.equal("staleAccounts" in body, false);
  });

  it("当日でない口座は onlineAccounts に残したまま、staleAccounts の重複は名前だけにする", async () => {
    const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
    await writeCache(ZAIM_CACHE_KEY, "test", {
      balances: [{ name: "三井住友銀行", amount: 100, lastUpdatedAt: null }],
      holdings: [],
      onlineAccounts: [
        { name: "古い口座", lastUpdatedAt: "2020-01-01T00:00:00+09:00" },
        { name: "今日の口座", lastUpdatedAt: `${today}T00:00:00+09:00` },
      ],
    });
    const body = parsed(await balancesTool.handler({}, { sessionId: null }));
    assert.equal(body["empty"], false);
    assert.deepEqual(body["staleAccountNames"], ["古い口座"]);
    assert.equal((body["onlineAccounts"] as unknown[]).length, 2);
    assert.equal("staleAccounts" in body, false);
  });
});
