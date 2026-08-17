import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ZAIM_SESSION_EXPIRED, isZaimSessionExpired } from "./errors.ts";
import { buildZaimRefreshResult } from "./parse.ts";
import type { ZaimRawRefreshResult, ZaimRefreshResult } from "./types.ts";

const execFileAsync = promisify(execFile);

// スクリプト側の最大待ち（既定15分）に、押下前後のページ読み込みぶんの余裕を足す。
// ここが短いと、待っている最中に execFile 側から殺されて結果を受け取れない。
const REFRESH_TIMEOUT_MS = 20 * 60_000;

const REFRESH_SCRIPT = fileURLToPath(new URL("./scripts/refresh.mjs", import.meta.url));

/**
 * Zaimの連携口座を一括更新する（「データを更新する」を押し、完了を待つ）。
 *
 * **押してから反映まで5〜15分かかるため、数十秒で終わる巡回よりさらに重い。**
 * MCPやAPIの同期リクエストから呼んではいけない。worker の `zaim-refresh` から
 * 巡回（`zaim-sync`）の前に定期実行する。
 */
export async function refreshZaimOnlineAccounts(): Promise<ZaimRefreshResult> {
  try {
    const { stdout } = await execFileAsync(process.execPath, [REFRESH_SCRIPT], {
      env: process.env,
      timeout: REFRESH_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });

    const result = JSON.parse(stdout) as ZaimRawRefreshResult;
    if (!Array.isArray(result.accounts)) {
      throw new Error("Zaim更新スクリプトの応答が不正です");
    }
    return buildZaimRefreshResult(result);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (isZaimSessionExpired(message)) {
      // 巡回（scrape.ts）と同じ言い換え。マーカーを残さないと、通知側が
      // 「手動ログインをやり直すまで直らない失敗」だと判別できなくなる。
      throw new Error(
        `Zaimのログインセッションが失効しています（${ZAIM_SESSION_EXPIRED}）。` +
          "scripts/login.mjs を実行し直してください。",
      );
    }
    throw cause;
  }
}
