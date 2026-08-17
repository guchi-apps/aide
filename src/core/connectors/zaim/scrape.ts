import { ZAIM_SESSION_EXPIRED, isZaimSessionExpired } from "./errors.ts";
import { buildZaimSnapshot } from "./parse.ts";
import { type ZaimScriptDeps, runZaimScript, zaimScriptPath } from "./session.ts";
import type { ZaimRawScrapeResult, ZaimSnapshot } from "./types.ts";

// 証券詳細ページを順に巡回するため、1ページ分より長い実行時間を許容する。
const SCRAPE_TIMEOUT_MS = 300_000;

// 呼び出し元のカレントディレクトリに依存しないよう、このモジュールからの相対で解決する。
// asset-manager では cwd 相対だったが、AIDEはワーカーからも叩くため成立しない。
const SCRAPE_SCRIPT = zaimScriptPath("scrape.mjs");

/**
 * Zaimの残高・保有銘柄を取得する。
 *
 * Playwrightでヘッドレスブラウザを起動するため**重く、数十秒かかる**。
 * MCPやAPIの同期リクエストから直接呼んではいけない。worker から定期実行し、
 * 結果をキャッシュに書いて、参照側はキャッシュを読む。
 *
 * Playwright本体はAIDEの依存に含めず、実行環境へグローバル導入する
 * （`npm install -g playwright && playwright install chromium`）。
 *
 * 一時的な失敗の再試行と、セッション失効時の自動再ログインは `runZaimScript` が担う。
 * 日次で1回しか走らないぶん、ここで落ちると翌日まで残高が古いままになるため、
 * セッション延長（`keepZaimSessionAlive`）と同じ回復経路を通している。
 */
export async function scrapeZaimSnapshot(deps?: ZaimScriptDeps): Promise<ZaimSnapshot> {
  try {
    const stdout = await runZaimScript(
      SCRAPE_SCRIPT,
      { timeout: SCRAPE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      deps,
    );

    const result = JSON.parse(stdout) as ZaimRawScrapeResult;
    if (!Array.isArray(result.balances)) {
      throw new Error("Zaim巡回スクリプトの応答が不正です");
    }
    return buildZaimSnapshot(result);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (isZaimSessionExpired(message)) {
      // マーカーを残したまま日本語へ言い換える。落とすと、この失敗が「手動ログインをやり直す
      // まで直らない失敗」であることを通知側（src/worker/notify.ts）が判別できなくなる。
      throw new Error(
        `Zaimのログインセッションが失効しています（${ZAIM_SESSION_EXPIRED}）。` +
          "scripts/login.mjs を実行し直してください。",
      );
    }
    throw cause;
  }
}
