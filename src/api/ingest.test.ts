import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

// 本番のキャッシュを汚さないよう、読み込み前に置き場を一時ディレクトリへ差し替える。
// CACHE_DIR はモジュール読み込み時に確定するため、import より前に設定する必要がある。
const cacheDir = await mkdtemp(join(tmpdir(), "aide-ingest-test-"));
process.env["AIDE_CACHE_DIR"] = cacheDir;
const { handleIngest } = await import("./ingest.ts");
const { readCache } = await import("../core/cache/store.ts");
const { jobRecordKey } = await import("../worker/record.ts");

const SECRET = "test-only-ingest-secret";

interface Captured {
  status: number;
  body: string;
}

/** `writeHead` / `end` だけを記録する最小のスタブ。 */
function fakeRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: "" };
  const res = {
    writeHead(status: number) {
      captured.status = status;
      return res;
    },
    end(body?: string) {
      captured.body = body ?? "";
      return res;
    },
  };
  return { res: res as unknown as ServerResponse, captured };
}

/** 受け口はボディを非同期イテレータとして読むため、そこだけ本物に合わせる。 */
function fakeReq(body: string, authorization: string | null): IncomingMessage {
  const headers: Record<string, string> = {};
  if (authorization !== null) headers["authorization"] = authorization;
  return {
    method: "POST",
    headers,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body, "utf8");
    },
  } as unknown as IncomingMessage;
}

async function post(key: string, body: unknown, authorization = `Bearer ${SECRET}`): Promise<Captured> {
  const { res, captured } = fakeRes();
  await handleIngest(fakeReq(JSON.stringify(body), authorization), res, key);
  return captured;
}

process.env["AIDE_INGEST_SECRET"] = SECRET;

after(async () => {
  delete process.env["AIDE_INGEST_SECRET"];
  await rm(cacheDir, { recursive: true, force: true });
});

describe("worker からの取り込み", () => {
  it("巡回結果を受け入れてキャッシュへ書く", async () => {
    const captured = await post("zaim-snapshot", { source: "zaim", data: { balances: [] } });

    assert.equal(captured.status, 200);
    const cached = await readCache<{ balances: unknown[] }>("zaim-snapshot");
    assert.deepEqual(cached?.data, { balances: [] });
  });

  // 記録もworkerから同じ経路で届く。ここで弾くと本番の /status が永久に「記録なし」になる（#89）。
  it("ジョブの実行記録を受け入れてキャッシュへ書く", async () => {
    const key = jobRecordKey("zaim-sync");
    const record = { job: "zaim-sync", ok: true, startedAt: "2026-08-18T14:35:08.000Z", seconds: 12.9, message: "取得した", host: "subpc" };

    const captured = await post(key, { source: "worker", data: record });

    assert.equal(captured.status, 200);
    const cached = await readCache<typeof record>(key);
    assert.deepEqual(cached?.data, record);
  });

  it("カタログにある全ジョブの記録キーを受け入れる", async () => {
    const { JOB_CATALOG } = await import("../worker/jobs/catalog.ts");

    for (const job of JOB_CATALOG) {
      const captured = await post(jobRecordKey(job.name), { source: "worker", data: { job: job.name } });
      assert.equal(captured.status, 200, `${job.name} の記録が受け入れられていない`);
    }
  });

  // 天気予報のキーが漏れていて、送信のたびに404になっていた（#108）。
  it("天気予報を受け入れてキャッシュへ書く", async () => {
    const { WEATHER_CACHE_KEY } = await import("../worker/jobs/weather-sync.ts");
    const forecast = { days: [{ date: "2026-08-19", summary: "晴れ" }] };

    const captured = await post(WEATHER_CACHE_KEY, { source: "open-meteo", data: forecast });

    assert.equal(captured.status, 200);
    const cached = await readCache<typeof forecast>(WEATHER_CACHE_KEY);
    assert.deepEqual(cached?.data, forecast);
  });

  it("未知のキーは404で弾く", async () => {
    const captured = await post("unknown-key", { source: "worker", data: {} });

    assert.equal(captured.status, 404);
    assert.equal(await readCache("unknown-key"), null);
  });

  it("シークレットが違えば401で弾く", async () => {
    const captured = await post("zaim-snapshot", { source: "zaim", data: { balances: [1] } }, "Bearer wrong");

    assert.equal(captured.status, 401);
  });
});
