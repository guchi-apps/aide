import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// CACHE_DIR はモジュール読み込み時に確定するため、import より前に差し替える。
process.env["AIDE_CACHE_DIR"] = await mkdtemp(join(tmpdir(), "aide-job-history-test-"));
const { MAX_RUNS, readJobRuns, writeCacheWithHistory } = await import("./job-history.ts");
const { readCache } = await import("../core/cache/store.ts");

const record = (n: number, ok = true) => ({
  job: "weather-sync",
  ok,
  startedAt: "2026-09-23T00:00:00.000Z",
  seconds: n,
  message: `run-${n}`,
  host: "subpc",
});

describe("実行記録の履歴", () => {
  it("新しい順に足し、30件を超えたら古いものから捨てる", async () => {
    for (let n = 1; n <= MAX_RUNS + 5; n++) {
      await writeCacheWithHistory("job-weather-sync", "worker", record(n));
    }
    const runs = await readJobRuns("job-weather-sync");
    assert.equal(runs.length, MAX_RUNS);
    assert.equal(runs[0]?.message, `run-${MAX_RUNS + 5}`);
    assert.equal(runs.at(-1)?.message, "run-6");
  });

  it("最新1件は従来のキーに上書きで残る", async () => {
    await writeCacheWithHistory("job-zaim-sync", "worker", record(1));
    await writeCacheWithHistory("job-zaim-sync", "worker", record(2, false));
    const latest = await readCache<{ message: string }>("job-zaim-sync");
    assert.equal(latest?.data.message, "run-2");
  });

  it("同時に届いても取りこぼさない", async () => {
    await Promise.all(
      [1, 2, 3, 4, 5].map((n) => writeCacheWithHistory("job-printer-watch", "worker", record(n))),
    );
    assert.equal((await readJobRuns("job-printer-watch")).length, 5);
  });

  it("実行記録でないキーには履歴を作らない", async () => {
    await writeCacheWithHistory("weather-forecast", "worker", { ok: true });
    assert.equal(await readCache("weather-forecast-history"), null);
    assert.deepEqual(await readJobRuns("weather-forecast"), []);
  });
});
