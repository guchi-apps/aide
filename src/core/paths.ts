import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** aide リポジトリのルート。このファイルは src/core/ にある。 */
export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * 永続データの置き場。gitignore 対象。
 * カレントディレクトリ相対にすると、workerとサーバーで参照先がずれる。
 */
export const DATA_DIR = resolve(REPO_ROOT, "data");
export const CACHE_DIR = resolve(DATA_DIR, "cache");
