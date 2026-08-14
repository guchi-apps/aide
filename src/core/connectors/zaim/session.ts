import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const KEEP_ALIVE_TIMEOUT_MS = 120_000;
const KEEP_ALIVE_SCRIPT = fileURLToPath(
  new URL("./scripts/keep-alive.mjs", import.meta.url),
);

/**
 * Zaimのログインセッションを延長する。
 *
 * 認証Cookieは約2時間で失効するが、アクセスのたびにその時点から延長される。
 * 巡回を行わない時間帯もこれを回しておけば、手動ログインなしで維持できる。
 * 残高画面を1ページ開くだけなので、巡回に比べて軽い。
 */
export async function keepZaimSessionAlive(): Promise<void> {
  await execFileAsync(process.execPath, [KEEP_ALIVE_SCRIPT], {
    env: process.env,
    timeout: KEEP_ALIVE_TIMEOUT_MS,
  });
}
