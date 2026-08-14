import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildZaimSnapshot } from "./parse.ts";
import type { ZaimRawScrapeResult, ZaimSnapshot } from "./types.ts";

const execFileAsync = promisify(execFile);

// 証券詳細ページを順に巡回するため、1ページ分より長い実行時間を許容する。
const SCRAPE_TIMEOUT_MS = 300_000;

// 呼び出し元のカレントディレクトリに依存しないよう、このモジュールからの相対で解決する。
// asset-manager では cwd 相対だったが、AIDEはワーカーからも叩くため成立しない。
const SCRAPE_SCRIPT = fileURLToPath(new URL("./scripts/scrape.mjs", import.meta.url));

/**
 * Zaimの残高・保有銘柄を取得する。
 *
 * Playwrightでヘッドレスブラウザを起動するため**重く、数十秒かかる**。
 * MCPやAPIの同期リクエストから直接呼んではいけない。worker から定期実行し、
 * 結果をキャッシュに書いて、参照側はキャッシュを読む。
 *
 * Playwright本体はAIDEの依存に含めず、実行環境へグローバル導入する
 * （`npm install -g playwright && playwright install chromium`）。
 */
export async function scrapeZaimSnapshot(): Promise<ZaimSnapshot> {
  try {
    const { stdout } = await execFileAsync(process.execPath, [SCRAPE_SCRIPT], {
      env: process.env,
      timeout: SCRAPE_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });

    const result = JSON.parse(stdout) as ZaimRawScrapeResult;
    if (!Array.isArray(result.balances)) {
      throw new Error("Zaim巡回スクリプトの応答が不正です");
    }
    return buildZaimSnapshot(result);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (message.includes("ZAIM_SESSION_EXPIRED")) {
      throw new Error(
        "Zaimのログインセッションが失効しています。scripts/login.mjs を実行し直してください。",
      );
    }
    throw cause;
  }
}
