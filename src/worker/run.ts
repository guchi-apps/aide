import { JOB_CATALOG, type JobName } from "./jobs/catalog.ts";
import { runWeatherSync } from "./jobs/weather-sync.ts";
import { runZaimKeepAlive } from "./jobs/zaim-keep-alive.ts";
import { runZaimRefresh } from "./jobs/zaim-refresh.ts";
import { runZaimSync } from "./jobs/zaim-sync.ts";
import { notifyJobFailure, notifyJobRecovered, summarizeFailure } from "./notify.ts";
import { recordJobRun } from "./record.ts";

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
  "weather-sync": runWeatherSync,
};

const name = process.argv[2];
if (!name || !(name in RUNNERS)) {
  console.error(`使い方: node src/worker/run.ts <${JOB_CATALOG.map((job) => job.name).join(" | ")}>`);
  process.exit(2);
}

const startedAtMs = Date.now();
const startedAt = new Date(startedAtMs).toISOString();
const elapsed = (): number => Math.round((Date.now() - startedAtMs) / 100) / 10;

try {
  const message = await RUNNERS[name as JobName]();
  console.log(`[${name}] ${message}（${elapsed()}秒）`);
  // 直前まで失敗していた場合だけ復旧を通知する。通常の成功では何も送らない。
  await notifyJobRecovered(name);
  // 通知が流れて消えるのに対し、記録は残る。動作状況ページ（/status）はこちらを読む。
  await recordJobRun({ job: name, ok: true, startedAt, seconds: elapsed(), message });
} catch (cause) {
  // 失敗は握りつぶさず終了コードに出す。スケジューラ側から検知できるようにするため。
  console.error(`[${name}] 失敗:`, cause instanceof Error ? cause.message : cause);
  // 終了コードは systemd に残るだけで誰にも届かないため、Signalyへも送る（#26）。
  // 通知側は例外を投げない作りにしてあり、送れなくてもここの終了コードは変わらない。
  await notifyJobFailure(name, cause);
  // 通知と同じ理由（1行に切り詰め済み）を記録へも残す。記録側も例外を投げない。
  await recordJobRun({
    job: name,
    ok: false,
    startedAt,
    seconds: elapsed(),
    message: summarizeFailure(cause).reason,
  });
  process.exit(1);
}
