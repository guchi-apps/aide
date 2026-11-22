import { hostname } from "node:os";
import { WORKER_JOBS_ENV, isAssigned, parseAssignment } from "./assignment.ts";
import { JOB_CATALOG, type JobName } from "./jobs/catalog.ts";
import { runClaudeSessionsSync } from "./jobs/claude-sessions-sync.ts";
import { runGmailWatch } from "./jobs/gmail-watch.ts";
import { runPrinterWatch } from "./jobs/printer-watch.ts";
import { runSelfUpdate } from "./jobs/self-update.ts";
import { runWeatherSync } from "./jobs/weather-sync.ts";
import { runZaimKeepAlive } from "./jobs/zaim-keep-alive.ts";
import { runZaimMoneySync } from "./jobs/zaim-money-sync.ts";
import { runZaimRefresh } from "./jobs/zaim-refresh.ts";
import { runZaimSync } from "./jobs/zaim-sync.ts";
import {
  clearJobFailure,
  clearZaimSessionExpiry,
  notifyJobFailure,
  summarizeFailure,
} from "./notify.ts";
import { recordJobRun } from "./record.ts";
import { askServer, notifySwitch, workerHostName } from "./server-assignment.ts";

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
  "self-update": async () => {
    const result = await runSelfUpdate();
    const returned = result.returnedFrom ? `${result.returnedFrom} から develop へ戻し、` : "";
    return result.updated
      ? `${returned}${result.before.slice(0, 7)} から ${result.after.slice(0, 7)} へ更新${result.dependenciesInstalled ? "し、依存を再導入" : ""}`
      : `${returned}origin/develop は最新です`;
  },
  "zaim-refresh": runZaimRefresh,
  "zaim-sync": runZaimSync,
  "zaim-money-sync": runZaimMoneySync,
  "zaim-keep-alive": runZaimKeepAlive,
  "weather-sync": runWeatherSync,
  "claude-sessions-sync": runClaudeSessionsSync,
  "printer-watch": runPrinterWatch,
  "gmail-watch": runGmailWatch,
};

/**
 * Zaimのログインセッションを使うジョブ。
 *
 * **成功はセッションが有効であることの証拠**なので、他のZaimジョブに残っている失効の失敗は
 * その時点で解消している。ジョブ単位の消去（`clearJobFailure`）では、12時間ごとの
 * `zaim-refresh` の失効の記録が30分ごとの `zaim-keep-alive` に直されても残ってしまう（#191）。
 */
const ZAIM_JOBS: readonly JobName[] = [
  "zaim-refresh",
  "zaim-sync",
  "zaim-money-sync",
  "zaim-keep-alive",
];

const name = process.argv[2];
if (!name || !(name in RUNNERS)) {
  console.error(`使い方: node src/worker/run.ts <${JOB_CATALOG.map((job) => job.name).join(" | ")}>`);
  process.exit(2);
}

// 担当外のホストでは何もせず成功で終わる（#874）。実行記録（recordJobRun）も残さない:
// 記録は全ホスト共通のキー1件へ上書きされるため、担当外のホストが「成功」を書くと、
// 担当ホストが止まっていても動作状況（/api/status）が新鮮に見えてしまう。
let assignment;
try {
  assignment = parseAssignment(process.env[WORKER_JOBS_ENV]);
} catch (cause) {
  console.error(`[${name}] ${cause instanceof Error ? cause.message : cause}`);
  process.exit(2);
}
if (!isAssigned(assignment, name as JobName)) {
  console.log(`[${name}] 担当外のため見送り（${hostname()}。${WORKER_JOBS_ENV} に含まれていません）`);
  process.exit(0);
}

// 担当ホストの正はサーバー（VPS）にある（#891）。`AIDE_WORKER_JOBS` はその手前のローカルの絞り込みとして残す。
// self-update はホスト自身の更新なので、担当に関係なく動かす（問い合わせはハートビートとして送る）。
const claimed = await askServer(name);
if (claimed.kind === "unsupported") {
  console.log(`[${name}] サーバーが担当の割り振りに未対応のため、${WORKER_JOBS_ENV} だけで判定しました`);
}
if (claimed.kind === "decided" && claimed.response.notice) {
  await notifySwitch(claimed.response.notice, claimed.response.mode);
}
if (name !== "self-update") {
  if (claimed.kind === "failed") {
    // 届かないときは二重実行を避けて動かさない。記録も残さない（job-<name> が古くなって気づける）。
    console.error(`[${name}] 担当を問い合わせられないため見送り（${workerHostName()}）: ${claimed.reason}`);
    process.exit(0);
  }
  if (claimed.kind === "decided" && !claimed.response.run) {
    console.log(
      `[${name}] 担当外のため見送り（${workerHostName()}。担当は ${claimed.response.owner}・モード ${claimed.response.mode}）`,
    );
    process.exit(0);
  }
}

const startedAtMs = Date.now();
const startedAt = new Date(startedAtMs).toISOString();
const elapsed = (): number => Math.round((Date.now() - startedAtMs) / 100) / 10;

try {
  const message = await RUNNERS[name as JobName]();
  console.log(`[${name}] ${message}（${elapsed()}秒）`);
  // 成功・復旧は通知しない（#702）。再発したとき改めて通知できるよう、失敗の記録だけ消す。
  await clearJobFailure(name);
  // Zaimのジョブが成功したなら、他のZaimジョブの失効も直っている（#191）。
  if (ZAIM_JOBS.includes(name as JobName)) await clearZaimSessionExpiry(name);
  // 通知が流れて消えるのに対し、記録は残る。動作状況（/api/status → ops-dashboard）はこちらを読む。
  await recordJobRun({ job: name, ok: true, startedAt, seconds: elapsed(), message });
} catch (cause) {
  // 失敗は握りつぶさず終了コードに出す。スケジューラ側から検知できるようにするため。
  console.error(`[${name}] 失敗:`, cause instanceof Error ? cause.message : cause);
  // 終了コードは systemd に残るだけで誰にも届かないため、Discordへも送る（#26・#702）。
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
