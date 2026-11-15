import { randomUUID } from "node:crypto";
import { isZaimSessionExpired } from "../core/connectors/zaim/errors.ts";
import {
  type ZaimScreenFileLock,
  tryAcquireZaimScreenFileLock,
} from "../core/connectors/zaim/screen-file-lock.ts";
import type { ZaimFailedMonth } from "../core/connectors/zaim/types.ts";
import { acquireZaimWebScreenLock, releaseZaimWebScreenLock } from "../core/connectors/zaim/web-screen-lock.ts";
import { type ZaimMoneySyncResult, syncZaimMoney } from "./jobs/zaim-money-sync.ts";

/**
 * 明細一覧の取り直しジョブ（#863）。**サブPCの受け口（`zaim-web-server.ts`）の中で動く。**
 *
 * 定期巡回（`zaim-money-sync`。11:30・23:30）を待たずに、Zaimの明細一覧をその場で取り直して
 * `GET /api/money/transactions` のキャッシュ（`zaim-money-snapshot`）を書き換える。中身は巡回と同じ
 * `syncZaimMoney`（今日を含む月＋前月）。**読むだけで、Zaimの取引は登録・更新・削除しない。**
 *
 * 形は商品内訳の手動再取得（`receipt-refresh-jobs.ts`・#600）と同じ: 受け付けたらすぐ `jobId` を返し、
 * 呼び出し元は `GET` で状態を読む。状態はメモリだけに持ち（取得した明細は `data/` へ書かない）、
 * 受け口が再起動すると消える。
 *
 * - 同時に動かすのは1件だけ。取得中の再依頼は受付済みのジョブを返す（Zaimへ余計にアクセスしない）
 * - 受け口の別のZaim画面操作（登録・編集・商品内訳の再取得）・定期巡回とは `busy`（待たずに断る）
 */

const JOB_RETENTION_MS = 60 * 60_000;

export type MoneyListRefreshFailureKind = "busy" | "session_expired" | "fetch_failed" | "internal";

export interface MoneyListRefreshFailure {
  kind: MoneyListRefreshFailureKind;
  retryable: boolean;
  message: string;
}

export interface MoneyListRefreshJob {
  jobId: string;
  status: "running" | "succeeded" | "failed";
  requestedAt: string;
  finishedAt?: string;
  /** 今回Zaimから読み取ってキャッシュへ送れた時刻（成功のときだけ）。 */
  fetchedAt?: string;
  result?: { entryCount: number; months: string[]; failedMonths: ZaimFailedMonth[] };
  failure?: MoneyListRefreshFailure;
}

export type MoneyListSubmitOutcome =
  | { ok: true; job: MoneyListRefreshJob; deduplicated: boolean }
  | { ok: false; failure: MoneyListRefreshFailure };

const RETRYABLE: Record<MoneyListRefreshFailureKind, boolean> = {
  busy: true,
  fetch_failed: true,
  // 再ログインできていない間は何度押しても直らない。人がログインし直す必要がある。
  session_expired: false,
  internal: true,
};

export interface MoneyListRefreshDeps {
  sync(): Promise<ZaimMoneySyncResult>;
  acquireProcessLock(): boolean;
  releaseProcessLock(): void;
  acquireFileLock(): Promise<ZaimScreenFileLock | null>;
  now(): number;
  newId(): string;
}

const defaultDeps: MoneyListRefreshDeps = {
  sync: syncZaimMoney,
  acquireProcessLock: acquireZaimWebScreenLock,
  releaseProcessLock: releaseZaimWebScreenLock,
  acquireFileLock: () => tryAcquireZaimScreenFileLock(),
  now: Date.now,
  newId: randomUUID,
};

function failure(kind: MoneyListRefreshFailureKind, message: string): MoneyListRefreshFailure {
  return { kind, retryable: RETRYABLE[kind], message };
}

export class MoneyListRefreshJobs {
  private readonly jobs = new Map<string, MoneyListRefreshJob>();
  private activeJobId: string | null = null;
  private readonly deps: MoneyListRefreshDeps;

  // parameter property は型ストリッピングで実行できない。
  constructor(deps: MoneyListRefreshDeps = defaultDeps) {
    this.deps = deps;
  }

  /** 依頼を受け付ける。**実行は待たずに** `running` のジョブを返す。 */
  submit(): MoneyListSubmitOutcome {
    this.prune();

    const active = this.activeJobId ? this.jobs.get(this.activeJobId) : undefined;
    if (active) return { ok: true, job: { ...active }, deduplicated: true };

    if (!this.deps.acquireProcessLock()) {
      return {
        ok: false,
        failure: failure("busy", "別のZaim Web版の操作を処理中です。完了してからもう一度依頼してください。"),
      };
    }

    const job: MoneyListRefreshJob = {
      jobId: this.deps.newId(),
      status: "running",
      requestedAt: new Date(this.deps.now()).toISOString(),
    };
    this.jobs.set(job.jobId, job);
    this.activeJobId = job.jobId;
    void this.run(job);
    return { ok: true, job: { ...job }, deduplicated: false };
  }

  get(jobId: string): MoneyListRefreshJob | null {
    this.prune();
    const job = this.jobs.get(jobId);
    return job ? { ...job } : null;
  }

  /** テストで実行の完了を待つための口。 */
  async idle(): Promise<void> {
    while (this.activeJobId) await new Promise((resolve) => setTimeout(resolve, 1));
  }

  private async run(job: MoneyListRefreshJob): Promise<void> {
    let fileLock: ZaimScreenFileLock | null = null;
    try {
      fileLock = await this.deps.acquireFileLock();
      if (!fileLock) {
        this.fail(job, failure("busy", "Zaimの定期巡回か商品内訳の再取得が実行中です。数分後にもう一度依頼してください。"));
        return;
      }
      try {
        const result = await this.deps.sync();
        const fetchedAt = new Date(this.deps.now()).toISOString();
        job.status = "succeeded";
        job.fetchedAt = fetchedAt;
        job.finishedAt = fetchedAt;
        job.result = { entryCount: result.entryCount, months: result.months, failedMonths: result.failedMonths };
        console.log(`[money-list-refresh] 取得: ${result.message}`);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (isZaimSessionExpired(message)) {
          this.fail(job, failure("session_expired", message.split("\n")[0] ?? message));
        } else {
          this.fail(job, failure("fetch_failed", `明細一覧の取り直しに失敗しました: ${message.split("\n")[0] ?? message}`));
        }
      }
    } catch (cause) {
      console.error("[money-list-refresh] 想定外の失敗", cause);
      this.fail(job, failure("internal", "明細一覧の取り直し中に想定外のエラーが起きました"));
    } finally {
      await fileLock?.release().catch(() => undefined);
      this.deps.releaseProcessLock();
      this.activeJobId = null;
    }
  }

  private fail(job: MoneyListRefreshJob, reason: MoneyListRefreshFailure): void {
    job.status = "failed";
    job.finishedAt = new Date(this.deps.now()).toISOString();
    job.failure = reason;
    console.warn(`[money-list-refresh] 失敗: kind=${reason.kind}`);
  }

  private prune(): void {
    const limit = this.deps.now() - JOB_RETENTION_MS;
    for (const [id, job] of this.jobs) {
      if (id !== this.activeJobId && Date.parse(job.finishedAt ?? job.requestedAt) < limit) this.jobs.delete(id);
    }
  }
}

export const moneyListRefreshJobs = new MoneyListRefreshJobs();
