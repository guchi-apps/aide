import { randomUUID } from "node:crypto";
import {
  type FetchReceiptDetailOutcome,
  type ZaimReceiptDetailEntry,
  type ZaimReceiptRefreshFailureKind,
  type ZaimReceiptRefreshInput,
  fetchZaimReceiptDetail,
  zaimReceiptDetailCacheKey,
} from "../core/connectors/zaim/receipt-refresh.ts";
import {
  type ZaimScreenFileLock,
  tryAcquireZaimScreenFileLock,
} from "../core/connectors/zaim/screen-file-lock.ts";
import { acquireZaimWebScreenLock, releaseZaimWebScreenLock } from "../core/connectors/zaim/web-screen-lock.ts";
import { publish } from "./sink.ts";

/**
 * 商品内訳の手動再取得ジョブ（#600）。**サブPCの受け口（`zaim-web-server.ts`）の中で動く。**
 *
 * 取得はPlaywrightで数十秒かかるため、リクエストの中では実行しない。受け付けたらすぐ `jobId` を返し、
 * 呼び出し元は `GET` で状態を読む（Web要求のタイムアウトで結果が失われない）。
 *
 * - **状態はメモリだけに持つ。** 取得した商品名・金額を `data/` へ書かない（READMEの方針）。受け口が再起動すると
 *   進行中・完了済みのジョブは消え、`GET` は `job_not_found` を返す。呼び出し元は依頼し直せばよい
 *   （読むだけの処理なので、やり直して困ることは無い）
 * - **同時に動かすのは1件だけ。** 同じ取引への連打は受付済みのジョブを返す（Zaimへ余計にアクセスしない）。
 *   別の取引は `busy`
 * - 成功した結果は `zaim-money-detail-<moneyId>` としてVPSのキャッシュへ送る。後続の
 *   `GET /api/money/transactions` が、定期巡回より新しければこちらを重ねて返す
 */

/** 完了したジョブを覚えておく時間。呼び出し元が結果を読みに来られれば足りる。 */
const JOB_RETENTION_MS = 60 * 60_000;
/** 結果の送信で待つ上限。サブPC→VPSが詰まっていても、ジョブを長く居座らせない。 */
const PUBLISH_TIMEOUT_MS = 15_000;
const PUBLISH_ATTEMPTS = 2;

export type ReceiptRefreshFailureKind = ZaimReceiptRefreshFailureKind | "busy" | "internal";

export interface ReceiptRefreshFailure {
  kind: ReceiptRefreshFailureKind;
  /** 時間を置いて依頼し直せば成功しうるか。 */
  retryable: boolean;
  message: string;
}

export interface ReceiptRefreshJob {
  jobId: string;
  moneyId: number;
  /** `running`（実行中）→ `succeeded` / `failed`。受付けただけの状態は成功ではない。 */
  status: "running" | "succeeded" | "failed";
  requestedAt: string;
  finishedAt?: string;
  /** **今回Zaimから読み取れた時刻**（成功のときだけ）。古いキャッシュの時刻ではない。 */
  fetchedAt?: string;
  result?: {
    entry: ZaimReceiptDetailEntry;
    /** 後続の読み取り（`/api/money/transactions`）から使えるようにVPSへ送れたか。 */
    cached: boolean;
  };
  failure?: ReceiptRefreshFailure;
}

export type SubmitOutcome =
  | { ok: true; job: ReceiptRefreshJob; deduplicated: boolean }
  | { ok: false; failure: ReceiptRefreshFailure };

/** 失敗の種類ごとに、時間を置いて依頼し直せば直りうるか。 */
const RETRYABLE: Record<ReceiptRefreshFailureKind | "busy" | "internal", boolean> = {
  busy: true,
  fetch_failed: true,
  detail_failed: true,
  // 再ログインできていない間は何度押しても直らない。人がログインし直す必要がある。
  session_expired: false,
  not_found: false,
  internal: true,
};

export interface ReceiptRefreshDeps {
  fetchDetail(input: ZaimReceiptRefreshInput): Promise<FetchReceiptDetailOutcome>;
  publishDetail(key: string, data: unknown): Promise<void>;
  acquireProcessLock(): boolean;
  releaseProcessLock(): void;
  acquireFileLock(): Promise<ZaimScreenFileLock | null>;
  now(): number;
  newId(): string;
}

const defaultDeps: ReceiptRefreshDeps = {
  fetchDetail: (input) => fetchZaimReceiptDetail(input),
  async publishDetail(key, data) {
    await publish(key, "zaim-receipt-detail", data, {
      attempts: PUBLISH_ATTEMPTS,
      timeoutMs: PUBLISH_TIMEOUT_MS,
    });
  },
  acquireProcessLock: acquireZaimWebScreenLock,
  releaseProcessLock: releaseZaimWebScreenLock,
  acquireFileLock: () => tryAcquireZaimScreenFileLock(),
  now: Date.now,
  newId: randomUUID,
};

function failure(kind: ReceiptRefreshFailureKind | "busy" | "internal", message: string): ReceiptRefreshFailure {
  return { kind, retryable: RETRYABLE[kind], message };
}

export class ReceiptRefreshJobs {
  private readonly jobs = new Map<string, ReceiptRefreshJob>();
  private activeJobId: string | null = null;

  private readonly deps: ReceiptRefreshDeps;

  // parameter property（`constructor(private readonly ...)`）は型ストリッピングで実行できない。
  constructor(deps: ReceiptRefreshDeps = defaultDeps) {
    this.deps = deps;
  }

  /** 依頼を受け付ける。**実行は待たずに** `running` のジョブを返す。 */
  submit(input: ZaimReceiptRefreshInput): SubmitOutcome {
    this.prune();

    const active = this.activeJobId ? this.jobs.get(this.activeJobId) : undefined;
    if (active) {
      if (active.moneyId === input.moneyId) return { ok: true, job: { ...active }, deduplicated: true };
      return {
        ok: false,
        failure: failure("busy", "別の取引の商品内訳を取得中です。完了してからもう一度依頼してください。"),
      };
    }

    // 受け口の中の他のZaim画面操作（登録・編集）と取り合う。待たせずに断る。
    if (!this.deps.acquireProcessLock()) {
      return {
        ok: false,
        failure: failure("busy", "別のZaim Web版の操作を処理中です。完了してからもう一度依頼してください。"),
      };
    }

    const job: ReceiptRefreshJob = {
      jobId: this.deps.newId(),
      moneyId: input.moneyId,
      status: "running",
      requestedAt: new Date(this.deps.now()).toISOString(),
    };
    this.jobs.set(job.jobId, job);
    this.activeJobId = job.jobId;
    void this.run(job, input);
    return { ok: true, job: { ...job }, deduplicated: false };
  }

  get(jobId: string): ReceiptRefreshJob | null {
    this.prune();
    const job = this.jobs.get(jobId);
    return job ? { ...job } : null;
  }

  /** テストで実行の完了を待つための口。 */
  async idle(): Promise<void> {
    while (this.activeJobId) await new Promise((resolve) => setTimeout(resolve, 1));
  }

  private async run(job: ReceiptRefreshJob, input: ZaimReceiptRefreshInput): Promise<void> {
    let fileLock: ZaimScreenFileLock | null = null;
    try {
      fileLock = await this.deps.acquireFileLock();
      if (!fileLock) {
        this.fail(job, failure("busy", "Zaimの定期巡回が実行中です。数分後にもう一度依頼してください。"));
        return;
      }

      const outcome = await this.deps.fetchDetail(input);
      if (!outcome.ok) {
        this.fail(job, failure(outcome.kind, outcome.reason));
        return;
      }

      const fetchedAt = new Date(this.deps.now()).toISOString();
      // 後続の読み取りで使うのは内訳を読めた結果だけ。内訳の無い取引（none）は重ねる意味が無い。
      let cached = false;
      if (outcome.entry.itemsStatus === "complete" || outcome.entry.itemsStatus === "partial") {
        try {
          await this.deps.publishDetail(zaimReceiptDetailCacheKey(input.moneyId), {
            entry: outcome.entry,
            fetchedAt,
          });
          cached = true;
        } catch (cause) {
          // 取得自体は成功している。後続の読み取りへ載らないことは `cached: false` で伝える。
          console.warn(
            `[receipt-refresh] 結果をキャッシュへ送れませんでした: moneyId=${input.moneyId} ${
              cause instanceof Error ? cause.message.split("\n")[0] : String(cause)
            }`,
          );
        }
      }

      job.status = "succeeded";
      job.fetchedAt = fetchedAt;
      job.finishedAt = fetchedAt;
      job.result = { entry: outcome.entry, cached };
      console.log(
        `[receipt-refresh] 取得: moneyId=${input.moneyId} itemsStatus=${outcome.entry.itemsStatus} cached=${cached}`,
      );
    } catch (cause) {
      console.error("[receipt-refresh] 想定外の失敗", cause);
      this.fail(job, failure("internal", "商品内訳の取得中に想定外のエラーが起きました"));
    } finally {
      await fileLock?.release().catch(() => undefined);
      this.deps.releaseProcessLock();
      this.activeJobId = null;
    }
  }

  private fail(job: ReceiptRefreshJob, reason: ReceiptRefreshFailure): void {
    job.status = "failed";
    job.finishedAt = new Date(this.deps.now()).toISOString();
    job.failure = reason;
    console.warn(`[receipt-refresh] 失敗: moneyId=${job.moneyId} kind=${reason.kind}`);
  }

  private prune(): void {
    const limit = this.deps.now() - JOB_RETENTION_MS;
    for (const [id, job] of this.jobs) {
      if (id !== this.activeJobId && Date.parse(job.finishedAt ?? job.requestedAt) < limit) this.jobs.delete(id);
    }
  }
}

/** 受け口が使う1つだけのジョブ置き場。 */
export const receiptRefreshJobs = new ReceiptRefreshJobs();
