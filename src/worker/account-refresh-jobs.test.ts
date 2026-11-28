import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ZaimRefreshResult } from "../core/connectors/zaim/types.ts";
import { type AccountRefreshDeps, AccountRefreshJobs } from "./account-refresh-jobs.ts";

const RESULT: ZaimRefreshResult = {
  pressed: true,
  waitedMs: 1000,
  timedOut: false,
  accounts: [{ name: "銀行", lastUpdatedAt: null, previousLastUpdatedAt: null, advanced: true }],
};

function harness(overrides: Partial<AccountRefreshDeps> = {}) {
  const held = new Set<string>();
  let nextId = 0;
  let clock = Date.parse("2026-11-28T03:00:00Z");
  let refreshCalls = 0;
  let syncCalls = 0;
  let resolveRefresh: (r: ZaimRefreshResult) => void = () => {};
  let rejectRefresh: (e: unknown) => void = () => {};
  const fileLock = (name: string) => async () => {
    if (held.has(name)) return null;
    held.add(name);
    return {
      release: async () => {
        held.delete(name);
      },
    };
  };
  const deps: AccountRefreshDeps = {
    refresh() {
      refreshCalls++;
      return new Promise((resolve, reject) => {
        resolveRefresh = resolve;
        rejectRefresh = reject;
      });
    },
    async sync() {
      syncCalls++;
      assert.ok(held.has("screen") && held.has("process"), "取り直しは画面と受け口のロックを持って行う");
      return { message: "ok", entryCount: 3, months: ["202611"], failedMonths: [] };
    },
    acquireRefreshLock: fileLock("refresh"),
    acquireScreenLock: fileLock("screen"),
    acquireSyncMarkerLock: fileLock("sync"),
    acquireProcessLock() {
      if (held.has("process")) return false;
      held.add("process");
      return true;
    },
    releaseProcessLock() {
      held.delete("process");
    },
    async sleep(ms) {
      clock += ms;
    },
    now: () => clock,
    newId: () => `00000000-0000-0000-0000-${String(++nextId).padStart(12, "0")}`,
    ...overrides,
  };
  return {
    jobs: new AccountRefreshJobs(deps),
    held,
    refreshCalls: () => refreshCalls,
    syncCalls: () => syncCalls,
    resolve: (r: ZaimRefreshResult = RESULT) => resolveRefresh(r),
    reject: (e: unknown) => rejectRefresh(e),
  };
}

async function accepted(jobs: AccountRefreshJobs) {
  const outcome = await jobs.submit();
  assert.ok(outcome.ok);
  return outcome;
}

describe("AccountRefreshJobs", () => {
  it("受付直後は running で、反映待ちの間は更新ロックだけを持つ", async () => {
    const h = harness();
    const s = await accepted(h.jobs);
    assert.equal(s.job.status, "running");
    assert.equal(s.job.phase, "refreshing");
    assert.deepEqual([...h.held], ["refresh"]);
  });

  it("完了後に明細一覧まで取り直し、口座ごとの結果と完了時刻を返す", async () => {
    const h = harness();
    const s = await accepted(h.jobs);
    h.resolve();
    await h.jobs.idle();
    const job = h.jobs.get(s.job.jobId);
    assert.equal(job?.status, "succeeded");
    assert.deepEqual(job?.result, RESULT);
    assert.ok(job?.refreshedAt && job.finishedAt);
    assert.equal(job?.moneyList?.status, "succeeded");
    assert.equal(h.held.size, 0);
  });

  it("実行中の再依頼は、同時に来ても受付済みのジョブを返す", async () => {
    const h = harness();
    const [a, b] = await Promise.all([accepted(h.jobs), accepted(h.jobs)]);
    assert.equal(a.job.jobId, b.job.jobId);
    assert.equal(b.deduplicated, true);
    assert.equal(h.refreshCalls(), 1);
  });

  for (const name of ["refresh", "screen", "sync", "process"]) {
    it(`${name} のロックが塞がっていれば busy で断り、押さない`, async () => {
      const h = harness();
      h.held.add(name);
      const s = await h.jobs.submit();
      assert.equal(s.ok, false);
      assert.equal(s.ok === false && s.failure.kind, "busy");
      assert.equal(h.refreshCalls(), 0);
      assert.deepEqual([...h.held], [name]);
    });
  }

  it("セッション失効は session_expired で再試行不可。取り直しはしない", async () => {
    const h = harness();
    const s = await accepted(h.jobs);
    h.reject(new Error("ZAIM_SESSION_EXPIRED"));
    await h.jobs.idle();
    const job = h.jobs.get(s.job.jobId);
    assert.equal(job?.status, "failed");
    assert.equal(job?.failure?.kind, "session_expired");
    assert.equal(job?.failure?.retryable, false);
    assert.equal(h.syncCalls(), 0);
    assert.equal(h.held.size, 0);
  });

  it("口座を1件も読めなければ失敗にする", async () => {
    const h = harness();
    const s = await accepted(h.jobs);
    h.resolve({ ...RESULT, accounts: [] });
    await h.jobs.idle();
    assert.equal(h.jobs.get(s.job.jobId)?.failure?.kind, "fetch_failed");
  });

  it("画面ロックが空かなければ、更新は成功のまま取り直しだけ busy にする", async () => {
    const h = harness();
    const s = await accepted(h.jobs);
    h.held.add("screen");
    h.resolve();
    await h.jobs.idle();
    const job = h.jobs.get(s.job.jobId);
    assert.equal(job?.status, "succeeded");
    assert.equal(job?.moneyList?.status, "failed");
    assert.equal(h.syncCalls(), 0);
    assert.deepEqual([...h.held], ["screen"]);
  });

  it("取り直しの失敗はジョブの失敗にしない", async () => {
    const h = harness({
      sync: async () => {
        throw new Error("boom");
      },
    });
    const s = await accepted(h.jobs);
    h.resolve();
    await h.jobs.idle();
    const job = h.jobs.get(s.job.jobId);
    assert.equal(job?.status, "succeeded");
    assert.equal(job?.moneyList?.status, "failed");
    assert.equal(h.held.size, 0);
  });
});
