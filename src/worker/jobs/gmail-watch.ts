import { GmailInbox, loadGmailInboxCredentials, type GmailInboxDeps } from "../../core/connectors/gmail-inbox/client.ts";

/**
 * メインのGmailの受信トレイへ `users.watch` をかけ直す（#829）。
 *
 * Morrowの「必要なメールのお知らせ」は、Gmailの新着をPub/Sub経由のpushで受けて判定する
 * （受け口は Morrow の `POST /api/mail/push`）。pushを出させる `users.watch` はGmailの資格情報を
 * 持つAIDEがかけ、**期限が7日**なので毎日かけ直す。かけ直しは上書きで、重なっても害はない。
 *
 * - トピック名（`AIDE_GMAIL_WATCH_TOPIC`＝`projects/<プロジェクト>/topics/<トピック>`）が未設定なら呼ばない。
 * - 失敗は例外にする。worker の共通処理が終了コード・Discord通知・実行記録へ流すので、黙って止まらない。
 * - 追加のIMAPアカウントは対象外（Gmail APIのメインだけ）。
 */
export function readGmailWatchTopic(env: NodeJS.ProcessEnv = process.env): string | null {
  const topic = (env["AIDE_GMAIL_WATCH_TOPIC"] ?? "").trim();
  return topic || null;
}

const TOPIC_PATTERN = /^projects\/[^/\s]+\/topics\/[^/\s]+$/;

export async function runGmailWatch(deps: GmailInboxDeps & { topic?: string | null } = {}): Promise<string> {
  const topic = deps.topic === undefined ? readGmailWatchTopic() : deps.topic;
  if (!topic) return "AIDE_GMAIL_WATCH_TOPIC が未設定のため、watchをかけませんでした";
  if (!TOPIC_PATTERN.test(topic)) {
    throw new Error("AIDE_GMAIL_WATCH_TOPIC は projects/<プロジェクト>/topics/<トピック> の形にしてください");
  }

  const credentials = deps.credentials === undefined ? loadGmailInboxCredentials() : deps.credentials;
  if (!credentials) {
    throw new Error(
      "Gmailの資格情報（AIDE_GMAIL_CLIENT_ID・AIDE_GMAIL_CLIENT_SECRET・AIDE_GMAIL_INBOX_REFRESH_TOKEN）が、このworkerの環境に設定されていません",
    );
  }

  const connected = await GmailInbox.connect({ ...deps, credentials });
  if (!connected.ok) throw new Error(`Gmailへ接続できませんでした: ${connected.reason}`);
  const watched = await connected.value.watch(topic);
  if (!watched.ok) throw new Error(`users.watch に失敗しました: ${watched.reason}`);

  const expiresAt = new Date(Number(watched.value.expiration));
  const until = Number.isNaN(expiresAt.getTime()) ? watched.value.expiration : expiresAt.toISOString();
  return `受信トレイへwatchをかけました（期限 ${until}）`;
}
