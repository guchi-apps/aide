import { JOB_CATALOG, type JobName } from "./jobs/catalog.ts";
import { runZaimKeepAlive } from "./jobs/zaim-keep-alive.ts";
import { runZaimRefresh } from "./jobs/zaim-refresh.ts";
import { runZaimSync } from "./jobs/zaim-sync.ts";
import { notifyJobFailure, notifyJobRecovered } from "./notify.ts";

/**
 * worker のエントリポイント。
 *
 *   node --env-file-if-exists=.env src/worker/run.ts <ジョブ名>
 *
 * 常駐させずワンショットで実行し、スケジューリングは外（cron / systemd timer / PM2）に任せる。
 * 常駐プロセスを増やさずに済み、失敗しても次回実行で自然に復旧するため。
 *
 * ジョブ名と説明は `jobs/catalog.ts` が持つ。ここは runner との対応付けだけを持ち、
 * `Record<JobName, ...>` の型でカタログとの取りこぼしを防いでいる。
 */
const RUNNERS: Record<JobName, () => Promise<string>> = {
  "zaim-refresh": runZaimRefresh,
  "zaim-sync": runZaimSync,
  "zaim-keep-alive": runZaimKeepAlive,
};

const name = process.argv[2];
if (!name || !(name in RUNNERS)) {
  console.error(`使い方: node src/worker/run.ts <${JOB_CATALOG.map((job) => job.name).join(" | ")}>`);
  process.exit(2);
}

const startedAt = Date.now();
try {
  const message = await RUNNERS[name as JobName]();
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[${name}] ${message}（${seconds}秒）`);
  // 直前まで失敗していた場合だけ復旧を通知する。通常の成功では何も送らない。
  await notifyJobRecovered(name);
} catch (cause) {
  // 失敗は握りつぶさず終了コードに出す。スケジューラ側から検知できるようにするため。
  console.error(`[${name}] 失敗:`, cause instanceof Error ? cause.message : cause);
  // 終了コードは systemd に残るだけで誰にも届かないため、Signalyへも送る（#26）。
  // 通知側は例外を投げない作りにしてあり、送れなくてもここの終了コードは変わらない。
  await notifyJobFailure(name, cause);
  process.exit(1);
}
