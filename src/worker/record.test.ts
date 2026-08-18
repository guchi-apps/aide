import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

// 本番のキャッシュを汚さないよう、読み込み前に置き場を一時ディレクトリへ差し替える。
// CACHE_DIR はモジュール読み込み時に確定するため、import より前に設定する必要がある。
const CACHE_DIR = await mkdtemp(join(tmpdir(), "aide-record-test-"));
process.env["AIDE_CACHE_DIR"] = CACHE_DIR;
const { readCache } = await import("../core/cache/store.ts");
const { jobRecordKey, recordJobRun } = await import("./record.ts");

interface StoredRecord {
  job: string;
  ok: boolean;
  seconds: number;
  message: string;
  host: string;
}

after(async () => {
  await rm(CACHE_DIR, { recursive: true, force: true });
});

describe("ジョブの実行記録", () => {
  it("ジョブごとに別のキーへ書く（1つにまとめると読み取り口が要る）", async () => {
    await recordJobRun({
      job: "zaim-sync",
      ok: true,
      startedAt: "2026-08-18T14:35:00.000Z",
      seconds: 42.1,
      message: "残高12件を取得した",
    });
    await recordJobRun({
      job: "zaim-keep-alive",
      ok: false,
      startedAt: "2026-08-18T14:40:00.000Z",
      seconds: 1.2,
      message: "Error: セッションが失効",
    });

    const sync = await readCache<StoredRecord>(jobRecordKey("zaim-sync"));
    const keepAlive = await readCache<StoredRecord>(jobRecordKey("zaim-keep-alive"));
    assert.equal(sync?.data.ok, true);
    assert.equal(sync?.data.message, "残高12件を取得した");
    // 後から書いた別ジョブの記録が、先に書いた記録を消していない。
    assert.equal(keepAlive?.data.ok, false);
    assert.equal(keepAlive?.data.message, "Error: セッションが失効");
  });

  it("実行ホストを添える（サブPCとVPSのどちらで動いたかを見分けるため）", async () => {
    await recordJobRun({
      job: "zaim-refresh",
      ok: true,
      startedAt: "2026-08-18T14:15:00.000Z",
      seconds: 5,
      message: "更新ボタンを押した",
    });
    const record = await readCache<StoredRecord>(jobRecordKey("zaim-refresh"));
    assert.ok(record && record.data.host.length > 0);
  });

  it("送信先が落ちていてもジョブ側へ例外を投げない", async () => {
    // 送信先を設定すると HTTP 経由になる。届かない先を指しても、記録の失敗で
    // ジョブを二重に失敗させてはいけない（notify.ts と同じ方針）。
    process.env["AIDE_INGEST_URL"] = "http://127.0.0.1:1";
    process.env["AIDE_INGEST_SECRET"] = "dummy";
    try {
      await recordJobRun({
        job: "zaim-sync",
        ok: true,
        startedAt: "2026-08-18T14:35:00.000Z",
        seconds: 1,
        message: "ok",
      });
    } finally {
      delete process.env["AIDE_INGEST_URL"];
      delete process.env["AIDE_INGEST_SECRET"];
    }
  });
});
