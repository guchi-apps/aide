import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CACHE_DIR } from "../paths.ts";

/**
 * 取得結果のキャッシュ。
 *
 * AIDEは「取得」と「提供」を分離する。Playwright巡回のような重い取得は worker が
 * 定期実行してここに書き、MCPサーバーとAPIはここを読むだけにする。
 * 同期リクエストの中で取得を走らせると、応答が数十秒かかりメモリも跳ねる。
 *
 * 保存先はJSONファイル。まだデータモデルが固まっていない段階でDBを入れると、
 * スキーマ変更のたびにマイグレーション運用のコストが先に来るため。
 * 形が安定したらMariaDBへ移す。
 */

export interface CacheEntry<T> {
  /** 取得元。どのコネクタが書いたか。 */
  source: string;
  /** 取得時刻（ISO8601）。鮮度の判断に使う。 */
  fetchedAt: string;
  data: T;
}

export interface CachedValue<T> extends CacheEntry<T> {
  /** 取得からの経過分数。 */
  ageMinutes: number;
}

function pathFor(key: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) {
    // キーはそのままファイル名になる。パス区切りや相対参照を弾く。
    throw new Error(`不正なキャッシュキー: ${key}`);
  }
  return join(CACHE_DIR, `${key}.json`);
}

export async function writeCache<T>(key: string, source: string, data: T): Promise<void> {
  const path = pathFor(key);
  await mkdir(dirname(path), { recursive: true });

  const entry: CacheEntry<T> = { source, fetchedAt: new Date().toISOString(), data };

  // 一時ファイルへ書いてから rename する。
  // 直接上書きすると、書き込み中に読まれたときに壊れたJSONを掴む。
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(entry, null, 2), "utf8");
  await rename(tmp, path);
}

/** キャッシュが無い場合は null を返す。呼び出し側で「まだ取得していない」を表現する。 */
export async function readCache<T>(key: string): Promise<CachedValue<T> | null> {
  let raw: string;
  try {
    raw = await readFile(pathFor(key), "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }

  const entry = JSON.parse(raw) as CacheEntry<T>;
  const ageMs = Date.now() - new Date(entry.fetchedAt).getTime();
  return { ...entry, ageMinutes: Math.max(0, Math.round(ageMs / 60_000)) };
}
