import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  FetchReceiptDetailOutcome,
  ZaimReceiptRefreshInput,
} from "../core/connectors/zaim/receipt-refresh.ts";
import { type ReceiptRefreshDeps, ReceiptRefreshJobs } from "./receipt-refresh-jobs.ts";

const INPUT: ZaimReceiptRefreshInput = { moneyId: 9001, date: "2026-10-09", amount: 1543 };
const COMPLETE: FetchReceiptDetailOutcome = {
  ok: true,
  entry: {
    id: 9001,
    date: "2026-10-09",
    amount: 1543,
    itemsStatus: "complete",
    items: [
      { id: 1, name: "牛乳", amount: 1543, quantity: null, unitPrice: null, discount: null, tax: null, category: "", genre: "" },
    ],
  },
};

/** 実行の開始と終了をテストが握れる差し替え。 */
function harness(overrides: Partial<ReceiptRefreshDeps> = {}) {
  let processLocked = false;
  let fileLocked = false;
  let nextId = 0;
  let clock = Date.parse("2026-10-10T03:00:00Z");
  const calls: ZaimReceiptRefreshInput[] = [];
  const published: Array<{ key: string; data: unknown }> = [];
  let release: (outcome: FetchReceiptDetailOutcome) => void = () => {};

  const deps: ReceiptRefreshDeps = {
    fetchDetail(input) {
      calls.push(input);
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    async publishDetail(key, data) {
      published.push({ key, data });
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
    jobs: new ReceiptRefreshJobs(deps),
    calls,
    published,
    finish: (outcome: FetchReceiptDetailOutcome) => release(outcome),
    holdFileLock: () => {
      fileLocked = true;
    },
    holdProcessLock: () => {
      processLocked = true;
    },
    tick: (ms: number) => {
      clock += ms;
    },
    isFileLocked: () => fileLocked,
    isProcessLocked: () => processLocked,
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

describe("ReceiptRefreshJobs", () => {
  it("受け付けた直後は running で、成功とは扱わない（fetchedAt も結果も無い）", async () => {
    const h = harness();
    const submitted = h.jobs.submit(INPUT);
    assert.ok(submitted.ok);
    assert.equal(submitted.job.status, "running");
    assert.equal(submitted.job.fetchedAt, undefined);
    assert.equal(submitted.job.result, undefined);
    await settle();
    assert.equal(h.jobs.get(submitted.job.jobId)?.status, "running");
    h.finish({ ok: false, kind: "fetch_failed", reason: "x" });
    await h.jobs.idle();
  });

  it("成功すると今回の取得時刻と結果を返し、結果を後続読み取り用のキーへ送る", async () => {
    const h = harness();
    const submitted = h.jobs.submit(INPUT);
    assert.ok(submitted.ok);
    await settle();
    h.tick(45_000);
    h.finish(COMPLETE);
    await h.jobs.idle();

    const job = h.jobs.get(submitted.job.jobId);
    assert.equal(job?.status, "succeeded");
    assert.equal(job?.fetchedAt, "2026-10-10T03:00:45.000Z");
    assert.equal(job?.result?.cached, true);
    assert.equal(job?.result?.entry.itemsStatus, "complete");
    assert.equal(h.published.length, 1);
    assert.equal(h.published[0]?.key, "zaim-money-detail-9001");
    assert.deepEqual((h.published[0]?.data as { fetchedAt: string }).fetchedAt, job?.fetchedAt);
    assert.equal(h.isFileLocked() || h.isProcessLocked(), false);
  });

  it("内訳の無い取引（none）は成功だがキャッシュへ送らない", async () => {
    const h = harness();
    const submitted = h.jobs.submit(INPUT);
    assert.ok(submitted.ok);
    await settle();
    h.finish({ ok: true, entry: { id: 9001, date: "2026-10-09", amount: 1543, itemsStatus: "none" } });
    await h.jobs.idle();
    assert.equal(h.jobs.get(submitted.job.jobId)?.status, "succeeded");
    assert.equal(h.jobs.get(submitted.job.jobId)?.result?.cached, false);
    assert.equal(h.published.length, 0);
  });

  it("結果のキャッシュ送信に失敗しても取得は成功で、cached:false で伝える", async () => {
    const h = harness({
      async publishDetail() {
        throw new Error("送信に失敗しました");
      },
    });
    const submitted = h.jobs.submit(INPUT);
    assert.ok(submitted.ok);
    await settle();
    h.finish(COMPLETE);
    await h.jobs.idle();
    const job = h.jobs.get(submitted.job.jobId);
    assert.equal(job?.status, "succeeded");
    assert.equal(job?.result?.cached, false);
  });

  it("連打: 実行中の同じ取引は受付済みのジョブを返し、Zaimへは1回しかアクセスしない", async () => {
    const h = harness();
    const first = h.jobs.submit(INPUT);
    const second = h.jobs.submit(INPUT);
    const third = h.jobs.submit(INPUT);
    assert.ok(first.ok && second.ok && third.ok);
    assert.equal(first.deduplicated, false);
    assert.equal(second.deduplicated, true);
    assert.equal(second.job.jobId, first.job.jobId);
    assert.equal(third.job.jobId, first.job.jobId);
    await settle();
    h.finish(COMPLETE);
    await h.jobs.idle();
    assert.equal(h.calls.length, 1);
  });

  it("別の取引の取得中は busy（retryable）で、2件目は走らせない", async () => {
    const h = harness();
    assert.ok(h.jobs.submit(INPUT).ok);
    const other = h.jobs.submit({ ...INPUT, moneyId: 9002 });
    assert.ok(!other.ok);
    assert.equal(other.failure.kind, "busy");
    assert.equal(other.failure.retryable, true);
    await settle();
    h.finish(COMPLETE);
    await h.jobs.idle();
    assert.equal(h.calls.length, 1);
  });

  it("完了後は同じ取引でも新しく取得し直す（古い結果を返し回さない）", async () => {
    const h = harness();
    const first = h.jobs.submit(INPUT);
    await settle();
    h.finish(COMPLETE);
    await h.jobs.idle();
    const second = h.jobs.submit(INPUT);
    assert.ok(first.ok && second.ok);
    assert.equal(second.deduplicated, false);
    assert.notEqual(second.job.jobId, first.job.jobId);
    await settle();
    h.finish(COMPLETE);
    await h.jobs.idle();
    assert.equal(h.calls.length, 2);
  });

  it("受け口内の別のZaim画面操作（登録・編集）中は busy で、Zaimを開かない", () => {
    const h = harness();
    h.holdProcessLock();
    const submitted = h.jobs.submit(INPUT);
    assert.ok(!submitted.ok);
    assert.equal(submitted.failure.kind, "busy");
    assert.equal(h.calls.length, 0);
  });

  it("定期巡回（別プロセス）が画面を使っている間は busy で失敗し、Zaimを開かず、ロックを持ち越さない", async () => {
    const h = harness();
    h.holdFileLock();
    const submitted = h.jobs.submit(INPUT);
    assert.ok(submitted.ok);
    await h.jobs.idle();
    const job = h.jobs.get(submitted.job.jobId);
    assert.equal(job?.status, "failed");
    assert.equal(job?.failure?.kind, "busy");
    assert.equal(job?.failure?.retryable, true);
    assert.equal(h.calls.length, 0);
    assert.equal(h.isProcessLocked(), false);
    // 定期巡回側のロックは奪わず、消しもしない。
    assert.equal(h.isFileLocked(), true);
  });

  it("認証切れ・取得失敗・見つからないを、種類と再試行可否で判別できる", async () => {
    const cases: Array<[Extract<FetchReceiptDetailOutcome, { ok: false }>["kind"], boolean]> = [
      ["session_expired", false],
      ["not_found", false],
      ["detail_failed", true],
      ["fetch_failed", true],
    ];
    for (const [kind, retryable] of cases) {
      const h = harness();
      const submitted = h.jobs.submit(INPUT);
      assert.ok(submitted.ok);
      await settle();
      h.finish({ ok: false, kind, reason: `理由:${kind}` });
      await h.jobs.idle();
      const job = h.jobs.get(submitted.job.jobId);
      assert.equal(job?.status, "failed", kind);
      assert.equal(job?.failure?.kind, kind);
      assert.equal(job?.failure?.retryable, retryable, kind);
      assert.equal(job?.fetchedAt, undefined, "失敗に取得時刻を付けない");
      assert.equal(job?.result, undefined);
      assert.equal(h.published.length, 0, "失敗の結果でキャッシュを上書きしない");
    }
  });

  it("想定外の例外でもジョブは failed(internal) になり、ロックを解放する", async () => {
    const h = harness({
      async fetchDetail() {
        throw new Error("boom");
      },
    });
    const submitted = h.jobs.submit(INPUT);
    assert.ok(submitted.ok);
    await h.jobs.idle();
    assert.equal(h.jobs.get(submitted.job.jobId)?.failure?.kind, "internal");
    assert.equal(h.isFileLocked() || h.isProcessLocked(), false);
    // 失敗のあとに次の依頼を受けられる。
    assert.ok(h.jobs.submit(INPUT).ok);
  });

  it("知らないジョブIDは null、完了から1時間たったジョブは忘れる", async () => {
    const h = harness();
    assert.equal(h.jobs.get("00000000-0000-0000-0000-00000000dead"), null);
    const submitted = h.jobs.submit(INPUT);
    assert.ok(submitted.ok);
    await settle();
    h.finish(COMPLETE);
    await h.jobs.idle();
    assert.ok(h.jobs.get(submitted.job.jobId));
    h.tick(61 * 60_000);
    assert.equal(h.jobs.get(submitted.job.jobId), null);
  });
});
