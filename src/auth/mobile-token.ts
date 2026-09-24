import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DATA_DIR } from "../core/paths.ts";

/**
 * iOSアプリなどネイティブクライアント向けの、読み取り専用の長期トークン。
 *
 * MCPのOAuthトークン（`store.ts`）とは**別の系統**にしている。あちらは `/mcp`（操作系ツールを含む）
 * に通るため、Keychainへ置いたトークンが漏れたときの被害範囲を `/api/mobile/*` の読み取りだけに
 * 限りたい。**このトークンは `/mcp` にも他の `/api/*` にも通らない。**
 *
 * - 発行は「許可メールでのGoogleログイン＋PKCE」を通ったときだけ（`src/api/mobile.ts`）
 * - **保存するのはSHA-256ハッシュだけ。** 平文はアプリへ返す1回きりで、ファイルからは復元できない
 * - 有効期間は固定（`TOKEN_TTL_MS`）。切れたら再ログインで取り直す。アプリからの失効も可能
 * - ファイルは 600。書き込みは直列化する（`store.ts` と同じ理由）
 */

const STORE_PATH = process.env["AIDE_MOBILE_TOKEN_PATH"]
  ? resolve(process.env["AIDE_MOBILE_TOKEN_PATH"])
  : join(DATA_DIR, "auth", "mobile-tokens.json");

/** 180日。 */
export const TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000;
/** 端末の入れ替えで増えても際限なく溜めない。古い順に捨てる。 */
const MAX_TOKENS = 20;

export interface MobileTokenRecord {
  /** トークンのSHA-256（hex）。 */
  hash: string;
  email: string;
  createdAt: string;
  expiresAt: number;
}

let cached: MobileTokenRecord[] | null = null;
let queue: Promise<unknown> = Promise.resolve();

function hashOf(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

async function load(): Promise<MobileTokenRecord[]> {
  if (cached) return cached;
  try {
    cached = JSON.parse(await readFile(STORE_PATH, "utf8")) as MobileTokenRecord[];
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    cached = [];
  }
  return cached;
}

async function save(records: MobileTokenRecord[]): Promise<void> {
  await mkdir(dirname(STORE_PATH), { recursive: true, mode: 0o700 });
  const tmp = `${STORE_PATH}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(records, null, 2), { encoding: "utf8", mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, STORE_PATH);
  } catch (cause) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw cause;
  }
  cached = records;
}

function mutate<R>(
  task: (records: MobileTokenRecord[]) => { next: MobileTokenRecord[] | null; result: R },
): Promise<R> {
  const run = async () => {
    const { next, result } = task(await load());
    if (next) await save(next);
    return result;
  };
  const done = queue.then(run, run);
  queue = done.catch(() => undefined);
  return done;
}

/** トークンを発行する。**返す平文はここでしか得られない。** */
export function issueMobileToken(
  email: string,
  now: number = Date.now(),
): Promise<{ token: string; expiresAt: number }> {
  const token = randomBytes(32).toString("base64url");
  const record: MobileTokenRecord = {
    hash: hashOf(token),
    email,
    createdAt: new Date(now).toISOString(),
    expiresAt: now + TOKEN_TTL_MS,
  };
  return mutate((records) => {
    const live = records.filter((r) => r.expiresAt > now);
    return { next: [...live, record].slice(-MAX_TOKENS), result: { token, expiresAt: record.expiresAt } };
  });
}

/** 有効なトークンならその記録を返す。ハッシュどうしの完全一致で引くため、平文の比較は起きない。 */
export async function findMobileToken(
  token: string,
  now: number = Date.now(),
): Promise<MobileTokenRecord | null> {
  if (!token) return null;
  const hash = hashOf(token);
  const found = (await load()).find((r) => r.hash === hash) ?? null;
  return found && found.expiresAt > now ? found : null;
}

/** 失効させる。実在したトークンを消したときだけ true。 */
export function revokeMobileToken(token: string): Promise<boolean> {
  const hash = hashOf(token);
  return mutate((records) => {
    const next = records.filter((r) => r.hash !== hash);
    return next.length === records.length ? { next: null, result: false } : { next, result: true };
  });
}

/** テスト用。プロセス内キャッシュを捨てる。 */
export function resetMobileTokenCache(): void {
  cached = null;
}
