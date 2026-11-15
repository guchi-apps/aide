import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ZaimMoneySyncResult } from "./jobs/zaim-money-sync.ts";
import { type MoneyListRefreshDeps, MoneyListRefreshJobs } from "./money-list-refresh-jobs.ts";

const RESULT: ZaimMoneySyncResult = { message: "ok", entryCount: 42, months: ["202610"], failedMonths: [] };

function harness(overrides: Partial<MoneyListRefreshDeps> = {}) {
  let processLocked = false;
  let fileLocked = false;
  let nextId = 0;
  let clock = Date.parse("2026-10-10T03:00:00Z");
  let syncCalls = 0;
  let resolveSync: (r: ZaimMoneySyncResult) => void = () => {};
  let rejectSync: (e: unknown) => void = () => {};
  const deps: MoneyListRefreshDeps = {
    sync() {
      syncCalls++;
      return new Promise((resolve, reject) => {
        resolveSync = resolve;
        rejectSync = reject;
      });
    },
    acquireProcessLock() {
      if (processLocked) return false;
      processLocked = true;
      return true;
    },
    releaseProcessLock() {
      processLocked = false;
    },
    async acquireFileLock() {
      if (fileLocked) return null;
      fileLocked = true;
      return {
        release: async () => {
          fileLocked = false;
        },
      };
    },
    now: () => clock,
    newId: () => `00000000-0000-0000-0000-${String(++nextId).padStart(12, "0")}`,
    ...overrides,
  };
  return {
    jobs: new MoneyListRefreshJobs(deps),
    syncCalls: () => syncCalls,
    resolve: (r: ZaimMoneySyncResult) => resolveSync(r),
    reject: (e: unknown) => rejectSync(e),
    tick: (ms: number) => {
      clock += ms;
    },
    holdFileLock: () => {
      fileLocked = true;
    },
    holdProcessLock: () => {
      processLocked = true;
    },
    locked: () => fileLocked || processLocked,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("MoneyListRefreshJobs", () => {
  it("受付直後は running で、成功とは扱わない", async () => {
    const h = harness();
    const s = h.jobs.submit();
    assert.ok(s.ok);
    assert.equal(s.job.status, "running");
    assert.equal(s.job.fetchedAt, undefined);
    await settle();
    h.resolve(RESULT);
    await h.jobs.idle();
  });

  it("成功すると取得時刻と件数を返し、ロックを手放す", async () => {
    const h = harness();
    const s = h.jobs.submit();
    assert.ok(s.ok);
    await settle();
    h.tick(60_000);
    h.resolve(RESULT);
    await h.jobs.idle();
    const job = h.jobs.get(s.job.jobId);
    assert.equal(job?.status, "succeeded");
    assert.equal(job?.fetchedAt, "2026-10-10T03:01:00.000Z");
    assert.equal(job?.result?.entryCount, 42);
    assert.equal(h.locked(), false);
  });

  it("取得中の再依頼は受付済みのジョブを返し、巡回を二重に走らせない", async () => {
    const h = harness();
    const a = h.jobs.submit();
    const b = h.jobs.submit();
    assert.ok(a.ok && b.ok);
    assert.equal(b.deduplicated, true);
    assert.equal(b.job.jobId, a.job.jobId);
    await settle();
    assert.equal(h.syncCalls(), 1);
    h.resolve(RESULT);
    await h.jobs.idle();
  });

  it("受け口の別のZaim操作中は busy で断る", () => {
    const h = harness();
    h.holdProcessLock();
    const s = h.jobs.submit();
    assert.ok(!s.ok);
    assert.equal(s.failure.kind, "busy");
    assert.equal(s.failure.retryable, true);
  });

  it("定期巡回（ファイルロック）の実行中は busy の失敗になり、取得しない", async () => {
    const h = harness();
    h.holdFileLock();
    const s = h.jobs.submit();
    assert.ok(s.ok);
    await h.jobs.idle();
    const job = h.jobs.get(s.job.jobId);
    assert.equal(job?.status, "failed");
    assert.equal(job?.failure?.kind, "busy");
    assert.equal(h.syncCalls(), 0);
  });

  it("セッション失効は再試行不可、それ以外の失敗は fetch_failed", async () => {
    const h = harness();
    const a = h.jobs.submit();
    assert.ok(a.ok);
    await settle();
    h.reject(new Error("Zaimのログインセッションが失効しています（ZAIM_SESSION_EXPIRED）"));
    await h.jobs.idle();
    assert.equal(h.jobs.get(a.job.jobId)?.failure?.kind, "session_expired");
    assert.equal(h.jobs.get(a.job.jobId)?.failure?.retryable, false);

    const b = h.jobs.submit();
    assert.ok(b.ok);
    await settle();
    h.reject(new Error("通信に失敗"));
    await h.jobs.idle();
    assert.equal(h.jobs.get(b.job.jobId)?.failure?.kind, "fetch_failed");
    assert.equal(h.locked(), false);
  });

  it("期限（1時間）を過ぎた完了ジョブは読めなくなる", async () => {
    const h = harness();
    const s = h.jobs.submit();
    assert.ok(s.ok);
    await settle();
    h.resolve(RESULT);
    await h.jobs.idle();
    h.tick(61 * 60_000);
    assert.equal(h.jobs.get(s.job.jobId), null);
  });
});
