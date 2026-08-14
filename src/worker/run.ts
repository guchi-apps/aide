import { runZaimKeepAlive } from "./jobs/zaim-keep-alive.ts";
import { runZaimSync } from "./jobs/zaim-sync.ts";

/**
 * worker のエントリポイント。
 *
 *   node --env-file-if-exists=.env src/worker/run.ts <ジョブ名>
 *
 * 常駐させずワンショットで実行し、スケジューリングは外（cron / systemd timer / PM2）に任せる。
 * 常駐プロセスを増やさずに済み、失敗しても次回実行で自然に復旧するため。
 */
const JOBS: Record<string, () => Promise<string>> = {
  "zaim-sync": runZaimSync,
  "zaim-keep-alive": runZaimKeepAlive,
};

const name = process.argv[2];
if (!name || !(name in JOBS)) {
  console.error(`使い方: node src/worker/run.ts <${Object.keys(JOBS).join(" | ")}>`);
  process.exit(2);
}

const startedAt = Date.now();
try {
  const message = await JOBS[name]!();
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[${name}] ${message}（${seconds}秒）`);
} catch (cause) {
  // 失敗は握りつぶさず終了コードに出す。スケジューラ側から検知できるようにするため。
  console.error(`[${name}] 失敗:`, cause instanceof Error ? cause.message : cause);
  process.exit(1);
}
