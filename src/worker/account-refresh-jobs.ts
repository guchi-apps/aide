import { randomUUID } from "node:crypto";
import { isZaimSessionExpired } from "../core/connectors/zaim/errors.ts";
import { refreshZaimOnlineAccounts } from "../core/connectors/zaim/refresh.ts";
import {
  ZAIM_REFRESH_FILE_LOCK_MAX_AGE_MS,
  ZAIM_REFRESH_FILE_LOCK_PATH,
  ZAIM_SYNC_FILE_LOCK_PATH,
  type ZaimScreenFileLock,
  tryAcquireZaimScreenFileLock,
} from "../core/connectors/zaim/screen-file-lock.ts";
import type { ZaimFailedMonth, ZaimRefreshResult } from "../core/connectors/zaim/types.ts";
import { acquireZaimWebScreenLock, releaseZaimWebScreenLock } from "../core/connectors/zaim/web-screen-lock.ts";
import { type ZaimMoneySyncResult, syncZaimMoney } from "./jobs/zaim-money-sync.ts";

/**
 * 連携口座の「データを更新する」を依頼されて押すジョブ（#918）。**サブPCの受け口の中で動く。**
 *
 * 押下と完了待ちは定期の `zaim-refresh` と同じ `refreshZaimOnlineAccounts`。終わったら続けて
 * 明細一覧の取り直し（`syncZaimMoney`）まで行う。状態はメモリだけに持ち、受け口が再起動すると消える。
 *
 * ## ロックの持ち方
 *
 * - **受付時**: 更新ロック（`refresh.lock`）を取り、画面ロック・巡回の印・受け口のロックが空いていることを
 *   確かめる。どれかが塞がっていれば `busy`
 * - **反映待ち（最大45分）**: 更新ロックだけを持つ。画面ロックや受け口のロックを持ち続けると、
 *   支払いの登録や巡回がその間ずっと止まる
 * - **明細一覧の取り直し**: 画面ロックと受け口のロックを、空くまで待って取る
 */

const JOB_RETENTION_MS = 60 * 60_000;

/** 明細一覧の取り直しで、ロックが空くのを待つ上限と間隔。 */
const SYNC_LOCK_WAIT_MS = 10 * 60_000;
const SYNC_LOCK_POLL_MS = 10_000;

export type AccountRefreshFailureKind = "busy" | "session_expired" | "fetch_failed" | "internal";

export interface AccountRefreshFailure {
  kind: AccountRefreshFailureKind;
  retryable: boolean;
  message: string;
}

export type AccountRefreshMoneyList =
  | { status: "succeeded"; fetchedAt: string; entryCount: number; months: string[]; failedMonths: ZaimFailedMonth[] }
  | { status: "failed"; failure: AccountRefreshFailure };

export interface AccountRefreshJob {
  jobId: string;
  status: "running" | "succeeded" | "failed";
  /** 実行中の段階。 */
  phase: "refreshing" | "syncing_money_list" | "done";
  requestedAt: string;
  finishedAt?: string;
  /** 連携口座の更新が終わった時刻。 */
  refreshedAt?: string;
  /** 口座ごとの更新結果（`buildZaimRefreshResult` の要約）。 */
  result?: ZaimRefreshResult;
  /** 更新後に続けた明細一覧の取り直し。失敗しても更新は済んでいるので、ジョブは成功のまま。 */
  moneyList?: AccountRefreshMoneyList;
  failure?: AccountRefreshFailure;
}

export type AccountRefreshSubmitOutcome =
  | { ok: true; job: AccountRefreshJob; deduplicated: boolean }
  | { ok: false; failure: AccountRefreshFailure };

const RETRYABLE: Record<AccountRefreshFailureKind, boolean> = {
  busy: true,
  fetch_failed: true,
  // 再ログインできていない間は何度押しても直らない。人がログインし直す必要がある。
  session_expired: false,
  internal: true,
};

export interface AccountRefreshDeps {
  refresh(): Promise<ZaimRefreshResult>;
  sync(): Promise<ZaimMoneySyncResult>;
  acquireRefreshLock(): Promise<ZaimScreenFileLock | null>;
  acquireScreenLock(): Promise<ZaimScreenFileLock | null>;
  acquireSyncMarkerLock(): Promise<ZaimScreenFileLock | null>;
  acquireProcessLock(): boolean;
  releaseProcessLock(): void;
  sleep(ms: number): Promise<unknown>;
  now(): number;
  newId(): string;
}

const defaultDeps: AccountRefreshDeps = {
  refresh: () => refreshZaimOnlineAccounts(),
  sync: syncZaimMoney,
  acquireRefreshLock: () =>
    tryAcquireZaimScreenFileLock(Date.now, ZAIM_REFRESH_FILE_LOCK_PATH, ZAIM_REFRESH_FILE_LOCK_MAX_AGE_MS),
  acquireScreenLock: () => tryAcquireZaimScreenFileLock(),
  acquireSyncMarkerLock: () => tryAcquireZaimScreenFileLock(Date.now, ZAIM_SYNC_FILE_LOCK_PATH),
  acquireProcessLock: acquireZaimWebScreenLock,
  releaseProcessLock: releaseZaimWebScreenLock,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
  newId: randomUUID,
};

function failure(kind: AccountRefreshFailureKind, message: string): AccountRefreshFailure {
  return { kind, retryable: RETRYABLE[kind], message };
}

function firstLine(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.split("\n")[0] ?? message;
}

function classify(cause: unknown, prefix: string): AccountRefreshFailure {
  const message = cause instanceof Error ? cause.message : String(cause);
  return isZaimSessionExpired(message)
    ? failure("session_expired", firstLine(cause))
    : failure("fetch_failed", `${prefix}: ${firstLine(cause)}`);
}

export class AccountRefreshJobs {
  private readonly jobs = new Map<string, AccountRefreshJob>();
  private activeJobId: string | null = null;
  private submitting: Promise<unknown> = Promise.resolve();
  private readonly deps: AccountRefreshDeps;

  // parameter property は型ストリッピングで実行できない。
  constructor(deps: AccountRefreshDeps = defaultDeps) {
    this.deps = deps;
  }

  /** 依頼を受け付ける。**実行は待たずに** `running` のジョブを返す。 */
  submit(): Promise<AccountRefreshSubmitOutcome> {
    // 受付はロックの確認で非同期になる。同時の依頼は順に処理し、2件目を `busy` ではなく受付済みにする。
    const next = this.submitting.then(() => this.accept());
    this.submitting = next.catch(() => undefined);
    return next;
  }

  get(jobId: string): AccountRefreshJob | null {
    this.prune();
    const job = this.jobs.get(jobId);
    return job ? { ...job } : null;
  }

  /** テストで実行の完了を待つための口。 */
  async idle(): Promise<void> {
    while (this.activeJobId) await new Promise((resolve) => setTimeout(resolve, 1));
  }

  private async accept(): Promise<AccountRefreshSubmitOutcome> {
    this.prune();

    const active = this.activeJobId ? this.jobs.get(this.activeJobId) : undefined;
    if (active) return { ok: true, job: { ...active }, deduplicated: true };

    const busy = (message: string): AccountRefreshSubmitOutcome => ({ ok: false, failure: failure("busy", message) });

    let refreshLock: ZaimScreenFileLock | null = null;
    try {
      refreshLock = await this.deps.acquireRefreshLock();
      if (!refreshLock) return busy("定期の「データを更新する」が実行中です。完了してからもう一度依頼してください。");

      const blocked = await this.findBlocker();
      if (blocked) {
        await refreshLock.release().catch(() => undefined);
        return busy(blocked);
      }
    } catch (cause) {
      await refreshLock?.release().catch(() => undefined);
      console.error("[account-refresh] 受付に失敗", cause);
      return { ok: false, failure: failure("internal", "連携口座の更新を受け付けられませんでした") };
    }

    const job: AccountRefreshJob = {
      jobId: this.deps.newId(),
      status: "running",
      phase: "refreshing",
      requestedAt: new Date(this.deps.now()).toISOString(),
    };
    this.jobs.set(job.jobId, job);
    this.activeJobId = job.jobId;
    const accepted = { ...job };
    void this.run(job, refreshLock);
    return { ok: true, job: accepted, deduplicated: false };
  }

  /** ほかのZaim画面操作が実行中なら理由を返す。確かめるだけで、ロックは持ち続けない。 */
  private async findBlocker(): Promise<string | null> {
    if (!this.deps.acquireProcessLock()) {
      return "別のZaim Web版の操作を処理中です。完了してからもう一度依頼してください。";
    }
    this.deps.releaseProcessLock();

    const screen = await this.deps.acquireScreenLock();
    if (!screen) return "Zaimの定期巡回か明細の取り直しが実行中です。数分後にもう一度依頼してください。";
    await screen.release().catch(() => undefined);

    const sync = await this.deps.acquireSyncMarkerLock();
    if (!sync) return "Zaimの定期巡回が実行中です。数分後にもう一度依頼してください。";
    await sync.release().catch(() => undefined);
    return null;
  }

  private async run(job: AccountRefreshJob, refreshLock: ZaimScreenFileLock): Promise<void> {
    try {
      let result: ZaimRefreshResult;
      try {
        result = await this.deps.refresh();
      } catch (cause) {
        this.fail(job, classify(cause, "連携口座の更新に失敗しました"));
        return;
      }
      if (result.accounts.length === 0) {
        // 定期の `zaim-refresh` と同じ扱い。押せていても完了を確認できていない。
        this.fail(job, failure("fetch_failed", "Zaimの連携口座と最終更新を1件も読み取れませんでした"));
        return;
      }

      job.result = result;
      job.refreshedAt = new Date(this.deps.now()).toISOString();
      job.phase = "syncing_money_list";
      job.moneyList = await this.syncMoneyList();
      job.status = "succeeded";
      job.phase = "done";
      job.finishedAt = new Date(this.deps.now()).toISOString();
      const advanced = result.accounts.filter((account) => account.advanced).length;
      console.log(
        `[account-refresh] 完了: ${result.accounts.length}件中${advanced}件が更新・明細一覧=${job.moneyList.status}`,
      );
    } catch (cause) {
      console.error("[account-refresh] 想定外の失敗", cause);
      this.fail(job, failure("internal", "連携口座の更新中に想定外のエラーが起きました"));
    } finally {
      await refreshLock.release().catch(() => undefined);
      this.activeJobId = null;
    }
  }

  private async syncMoneyList(): Promise<AccountRefreshMoneyList> {
    try {
      const deadline = this.deps.now() + SYNC_LOCK_WAIT_MS;
      for (;;) {
        if (this.deps.acquireProcessLock()) {
          let screen: ZaimScreenFileLock | null = null;
          try {
            screen = await this.deps.acquireScreenLock();
            if (screen) {
              const synced = await this.deps.sync();
              return {
                status: "succeeded",
                fetchedAt: new Date(this.deps.now()).toISOString(),
                entryCount: synced.entryCount,
                months: synced.months,
                failedMonths: synced.failedMonths,
              };
            }
          } finally {
            await screen?.release().catch(() => undefined);
            this.deps.releaseProcessLock();
          }
        }
        if (this.deps.now() >= deadline) {
          return {
            status: "failed",
            failure: failure("busy", "別のZaim操作が終わらず、明細一覧を取り直せませんでした。明細一覧の取り直しを依頼してください。"),
          };
        }
        await this.deps.sleep(SYNC_LOCK_POLL_MS);
      }
    } catch (cause) {
      return { status: "failed", failure: classify(cause, "明細一覧の取り直しに失敗しました") };
    }
  }

  private fail(job: AccountRefreshJob, reason: AccountRefreshFailure): void {
    job.status = "failed";
    job.phase = "done";
    job.finishedAt = new Date(this.deps.now()).toISOString();
    job.failure = reason;
    console.warn(`[account-refresh] 失敗: kind=${reason.kind}`);
  }

  private prune(): void {
    const limit = this.deps.now() - JOB_RETENTION_MS;
    for (const [id, job] of this.jobs) {
      if (id !== this.activeJobId && Date.parse(job.finishedAt ?? job.requestedAt) < limit) this.jobs.delete(id);
    }
  }
}

/** 受け口が使う1つだけのジョブ置き場。 */
export const accountRefreshJobs = new AccountRefreshJobs();
