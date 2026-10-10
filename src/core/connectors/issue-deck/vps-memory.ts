/**
 * 本番 issue-deck のVPSメモリ計測結果の取得コネクタ（#608。API提供側は guchi-apps/issue-deck#4256）。
 *
 * `GET /api/integrations/vps-memory`（契約: issue-deck の docs/vps-memory-probe.md）を**そのまま中継する**。
 * 取得不可（`latest.status: "unavailable"` と `reason`）・`lastSuccessAt`・`latestAgeSeconds`・
 * `segments`（PID・起動時刻ごとの別プロセス）は加工も合算もしない。取得できなかったことを0件・0MBへ丸めない。
 *
 * 接続・認証・エラーの丸め方は開発サマリー（`development-summary.ts`）と同じ。違うのは共有トークン名だけ。
 * 新しい環境変数・デプロイ設定は増やさない（`SHARED_TOKEN_API_SECRET` は配線済み）。値は応答・ログへ出さない。
 */

import type { DevelopmentSummaryConfig } from "./development-summary.ts";
import { getSharedToken } from "./shared-tokens.ts";

export const VPS_MEMORY_PATH = "/api/integrations/vps-memory";

/** どちらかが無ければ null（＝IssueDeckへ送信しない）。戻り値はログ・応答へ出さない。 */
export async function readVpsMemoryConfig(): Promise<DevelopmentSummaryConfig | null> {
  const baseUrl = process.env["AIDE_ISSUE_DECK_URL"];
  const shared = await getSharedToken("ISSUE_DECK_VPS_MEMORY_TOKEN", "aide");
  if (!baseUrl || !shared) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token: shared };
}
