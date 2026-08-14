import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** aide リポジトリのルート。このファイルは src/core/connectors/zaim/scripts/ にある。 */
const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url))

/**
 * Zaimのログイン状態（Playwright storage state）の保存先。
 *
 * カレントディレクトリ相対にすると、ワーカーからの実行時に保存先がずれて
 * 毎回ログインを要求されるため、リポジトリ基準で解決する。
 */
export function resolveStatePath() {
    const configured = process.env.ZAIM_STORAGE_STATE_PATH
    return configured ? resolve(configured) : resolve(REPO_ROOT, "data/zaim/storage-state.json")
}
