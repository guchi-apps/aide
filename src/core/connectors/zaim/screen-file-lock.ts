import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DATA_DIR } from "../../paths.ts";

/**
 * Zaimの画面を開く処理を**プロセスをまたいで**1つに絞るロック（#600）。
 *
 * `web-screen-lock.ts` は受け口プロセスの中でしか見えない。一方、定期巡回（`zaim-money-sync`）は
 * systemd が別プロセスで起こすため、手動の再取得と同時に走るとログイン状態のファイル
 * （storage state）を2つのChromiumが同時に更新し、セッションを壊しうる。そこで、**商品内訳の
 * 手動再取得と家計簿明細の定期巡回だけは**このファイルロックを取り合う。
 *
 * 中身はプロセスIDと取得時刻だけ（シークレットも取得したデータも書かない）。
 * 取得したプロセスが落ちて残ったロックは、**持ち主のプロセスが居ない**か**上限時間を超えた**ときに
 * 奪ってよい。
 */

/** ロックを持ち続けてよい上限。巡回1回の最大（2か月ぶん×子プロセスの上限）より長く取る。 */
export const ZAIM_SCREEN_FILE_LOCK_MAX_AGE_MS = 15 * 60_000;

/** 既定の置き場。`data/` は gitignore 済み（ログイン状態のファイルと同じ場所）。 */
export const ZAIM_SCREEN_FILE_LOCK_PATH = resolve(DATA_DIR, "zaim/screen.lock");

interface LockBody {
  pid: number;
  acquiredAt: number;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM は「居るが権限が無い」。居ないと決めつけて奪わない。
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLock(path: string): Promise<LockBody | null> {
  try {
    const body = JSON.parse(await readFile(path, "utf8")) as Partial<LockBody>;
    if (Number.isInteger(body.pid) && typeof body.acquiredAt === "number") return body as LockBody;
    return null;
  } catch {
    return null;
  }
}

export interface ZaimScreenFileLock {
  release(): Promise<void>;
}

/**
 * 取れたらロックを返す。他のプロセスが画面を使っていれば null（待たない）。
 * `now` はテスト用。
 */
export async function tryAcquireZaimScreenFileLock(
  now: () => number = Date.now,
  path: string = ZAIM_SCREEN_FILE_LOCK_PATH,
): Promise<ZaimScreenFileLock | null> {
  await mkdir(dirname(path), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // `wx`: 既にあれば失敗する。存在確認と作成を1回で行い、取り合いを防ぐ。
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: now() } satisfies LockBody));
      } finally {
        await handle.close();
      }
      return {
        release: async () => {
          // 自分のロックだけを消す（奪われた後に他人のロックを消さない）。
          const current = await readLock(path);
          if (current?.pid === process.pid) await rm(path, { force: true });
        },
      };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    }

    const holder = await readLock(path);
    // 中身を読めないのは、作成した直後でまだ書き込み中の可能性がある。少し経っても読めなければ壊れとみなす。
    const unreadableForLong =
      holder === null && (await stat(path).then((s) => now() - s.mtimeMs > 10_000, () => true));
    const stale =
      unreadableForLong ||
      (holder !== null &&
        (!processAlive(holder.pid) || now() - holder.acquiredAt > ZAIM_SCREEN_FILE_LOCK_MAX_AGE_MS));
    if (!stale) return null;
    await rm(path, { force: true });
  }
  return null;
}

/**
 * 取れるまで待つ版。定期巡回のように**待ってよい側**が使う（手動再取得は待たずに断る）。
 * 上限まで待っても取れなければ null。
 */
export async function acquireZaimScreenFileLockWaiting(
  options: {
    timeoutMs?: number;
    pollMs?: number;
    sleep?: (ms: number) => Promise<unknown>;
    now?: () => number;
    path?: string;
  } = {},
): Promise<ZaimScreenFileLock | null> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (options.timeoutMs ?? 5 * 60_000);
  for (;;) {
    const lock = await tryAcquireZaimScreenFileLock(now, options.path);
    if (lock) return lock;
    if (now() >= deadline) return null;
    await sleep(options.pollMs ?? 5_000);
  }
}
