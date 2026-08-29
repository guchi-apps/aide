import { isZaimAutoReloginFailed, isZaimSessionExpired, zaimSessionExpiredMessage } from "./errors.ts";
import { buildZaimRefreshResult } from "./parse.ts";
import { type ZaimScriptDeps, runZaimScript, zaimScriptPath } from "./session.ts";
import type { ZaimRawRefreshResult, ZaimRefreshResult } from "./types.ts";

// スクリプト側の最大待ち（既定45分）に、押下前後のページ読み込みぶんの余裕を足す。
// ここが短いと、待っている最中に execFile 側から殺されて結果を受け取れない。
const REFRESH_TIMEOUT_MS = 50 * 60_000;

const REFRESH_SCRIPT = zaimScriptPath("refresh.mjs");

/**
 * Zaimの連携口座を一括更新する（「データを更新する」を押し、完了を待つ）。
 *
 * **押してから反映まで最大45分待つため、数十秒で終わる巡回よりさらに重い。**
 * MCPやAPIの同期リクエストから呼んではいけない。worker の `zaim-refresh` から
 * 巡回（`zaim-sync`）の65分前に定期実行する。
 *
 * 一時的な失敗の再試行と、セッション失効時の自動再ログインは `runZaimScript` が担う。
 * **以前はここだけ `execFile` を直呼びしており**、失効すると自動再ログインを試さないまま
 * 落ちていた。そのぶん「データを更新する」が押されず、65分後の巡回が前回更新時点の残高を
 * 当日の値として記録していた（#190。#62 で潰したはずの状態に戻っていた）。
 *
 * `totalTimeout` を渡すのはここだけ。1回で最大45分待つため、やり直しを無制限に許すと
 * systemd の `TimeoutStartSec`（55分）に掛かって途中で殺され、押下の結果すら受け取れない。
 */
export async function refreshZaimOnlineAccounts(deps?: ZaimScriptDeps): Promise<ZaimRefreshResult> {
  try {
    const stdout = await runZaimScript(
      REFRESH_SCRIPT,
      {
        timeout: REFRESH_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        totalTimeout: REFRESH_TIMEOUT_MS,
      },
      deps,
    );

    const result = JSON.parse(stdout) as ZaimRawRefreshResult;
    if (!Array.isArray(result.accounts)) {
      throw new Error("Zaim更新スクリプトの応答が不正です");
    }
    return buildZaimRefreshResult(result);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (isZaimSessionExpired(message)) {
      // マーカーを残したまま日本語へ言い換える。落とすと、この失敗がセッション失効であることも、
      // 自動再ログインで直らなかったのかも、通知側（src/worker/notify.ts）が判別できなくなる。
      throw new Error(zaimSessionExpiredMessage(isZaimAutoReloginFailed(message)));
    }
    throw cause;
  }
}
