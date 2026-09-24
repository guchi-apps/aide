import { sendPush } from "../core/push/send.ts";

/**
 * 登録済みの端末へテスト通知を送る（aide#463）。
 *
 *   npm run push-test [-- <path>]   # path は既定 /map
 *
 * APNsの認証情報（AIDE_APNS_*）がある環境（本番のVPS）で実行する。
 */
const path = process.argv[2] ?? "/map";
const summary = await sendPush("test", path);
console.log(JSON.stringify(summary));
if (!summary.configured) {
  console.error("AIDE_APNS_KEY / AIDE_APNS_KEY_ID / AIDE_APNS_TEAM_ID が未設定です");
  process.exitCode = 1;
} else if (summary.sent === 0) {
  process.exitCode = 1;
}
