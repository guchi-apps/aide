import { randomBytes } from "node:crypto";

/**
 * Gmail送信（aide#230）。
 *
 * README「Gmailを載せていない理由（aide#173）」で見送ったのは**読み取り**（`gmail.readonly`）。
 * こちらは送信専用（`gmail.send`）で、メール本文を読む権限を持たない別のスコープなので、
 * aide#173の判断はそのまま当てはまらない——改めてこのIssueで判断している。
 *
 * `gmail.send` も sensitive scope にあたり、OAuth同意画面が「テスト」ステータスのままだと
 * リフレッシュトークンが7日で失効する（aide#173と同じ制約）。運用では同意画面を「本番」へ
 * 切り替えておく必要がある（実施はユーザーの手作業）。
 *
 * `googleapis` 等のSDKは入れず、依存ゼロの方針（README「依存関係の追加」）に従って
 * `fetch` とMIMEの手組みだけで実装する。アクセストークンはキャッシュしない——送信頻度が
 * 低く（人が写真を送る操作が起点）、毎回1往復増える程度のコストは無視できる一方、
 * 有効期限管理や並行アクセスの競合を持ち込むと複雑さのほうが上回る。
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SEND_URL = "https://www.googleapis.com/gmail/v1/users/me/messages/send";

const TOKEN_TIMEOUT_MS = 10_000;
const SEND_TIMEOUT_MS = 30_000;

export interface GmailCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/**
 * 環境変数は process.env を直接参照する（引数でenvを差し替えられるようにしない）。
 * src/deploy-env-wiring.test.ts はソース中の直接参照だけを走査して本番の配線漏れを
 * 検知するため、関数の引数経由の間接参照にすると検査から漏れる。
 */
export function loadGmailCredentials(): GmailCredentials | null {
  const clientId = (process.env["AIDE_GMAIL_CLIENT_ID"] ?? "").trim();
  const clientSecret = (process.env["AIDE_GMAIL_CLIENT_SECRET"] ?? "").trim();
  const refreshToken = (process.env["AIDE_GMAIL_REFRESH_TOKEN"] ?? "").trim();
  if (!clientId || !clientSecret || !refreshToken) return null;
  return { clientId, clientSecret, refreshToken };
}

export interface ImageMailRecipients {
  to: string[];
  bcc: string[];
}

/** カンマ区切りの環境変数からメールアドレスの配列を作る。 */
function splitAddresses(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((address) => address.trim())
    .filter((address) => address !== "");
}

export function loadImageMailRecipients(): ImageMailRecipients | null {
  const to = splitAddresses(process.env["AIDE_IMAGE_MAIL_TO"]);
  if (to.length === 0) return null;
  return { to, bcc: splitAddresses(process.env["AIDE_IMAGE_MAIL_BCC"]) };
}

type TokenOutcome = { ok: true; accessToken: string } | { ok: false; kind: "unauthorized" | "failed"; reason: string };

async function fetchAccessToken(
  credentials: GmailCredentials,
  fetchImpl: typeof fetch,
): Promise<TokenOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);
  try {
    const response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        refresh_token: credentials.refreshToken,
      }).toString(),
      signal: controller.signal,
    });

    if (!response.ok) {
      // 401/400（invalid_grant 等）はリフレッシュトークンそのものが失効している。
      // 何も送信されていないことが確実なので unauthorized（呼び出し元は abandon してよい）。
      const kind = response.status === 401 || response.status === 400 ? "unauthorized" : "failed";
      return { ok: false, kind, reason: `Gmailのアクセストークン取得に失敗しました（${response.status}）` };
    }

    const payload = (await response.json()) as { access_token?: unknown };
    if (typeof payload.access_token !== "string" || !payload.access_token) {
      return { ok: false, kind: "failed", reason: "Gmailのアクセストークン応答が不正です" };
    }
    return { ok: true, accessToken: payload.access_token };
  } catch (cause) {
    const aborted = cause instanceof Error && cause.name === "AbortError";
    return {
      ok: false,
      kind: "failed",
      reason: aborted ? "Gmailのアクセストークン取得がタイムアウトしました" : "Gmailへ接続できませんでした",
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** RFC 2047: 非ASCII件名を `=?UTF-8?B?...?=` へエンコードする。 */
function encodeSubject(subject: string): string {
  return `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

/** RFC 2045: base64本文は76文字ごとに改行する。 */
function chunkBase64(base64: string): string {
  return (base64.match(/.{1,76}/g) ?? []).join("\r\n");
}

export interface BuildMimeMessageInput {
  to: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
  attachment: { filename: string; contentType: string; data: Buffer };
}

/**
 * RFC 2822 のメッセージ本文（`multipart/mixed`）を組み立てる。
 *
 * 本文・添付ともに `Content-Transfer-Encoding: base64` にし、メッセージ全体をASCIIだけで
 * 構成する（quoted-printableとの使い分けをせず実装を単純にする）。**`From` は書かない**——
 * Gmail APIが認可されたアカウントのアドレスを自動で補完するため、誤った送信元を書いて
 * 拒否される余地を無くす。
 */
export function buildMimeMessage(input: BuildMimeMessageInput): string {
  const boundary = `----aide-image-mail-${randomBytes(16).toString("hex")}`;
  const headers = [
    `To: ${input.to.join(", ")}`,
    ...(input.bcc.length > 0 ? [`Bcc: ${input.bcc.join(", ")}`] : []),
    `Subject: ${encodeSubject(input.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];

  const bodyPart = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    chunkBase64(Buffer.from(input.bodyText, "utf8").toString("base64")),
  ].join("\r\n");

  const attachmentPart = [
    `--${boundary}`,
    `Content-Type: ${input.attachment.contentType}; name="${input.attachment.filename}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${input.attachment.filename}"`,
    "",
    chunkBase64(input.attachment.data.toString("base64")),
  ].join("\r\n");

  return [headers.join("\r\n"), "", bodyPart, attachmentPart, `--${boundary}--`, ""].join("\r\n");
}

export type GmailSendOutcome =
  | { ok: true; messageId: string }
  | { ok: false; kind: "unauthorized" | "rejected" | "failed"; reason: string };

/**
 * Gmail APIでメッセージを送信する。
 *
 * `kind` の切り分けは呼び出し元（`send.ts`）の再送判断に使う。
 * - `unauthorized`: 資格情報そのものが無効。**送信されていないことが確実**
 * - `rejected`: Gmailが内容を拒んだ（400/403）。**送信されていないことが確実**
 * - `failed`: タイムアウト・5xx・429・通信断。**送信されたかどうか不明**
 */
export async function sendGmailMessage(
  credentials: GmailCredentials,
  input: BuildMimeMessageInput,
  fetchImpl: typeof fetch = fetch,
): Promise<GmailSendOutcome> {
  const token = await fetchAccessToken(credentials, fetchImpl);
  if (!token.ok) return { ok: false, kind: token.kind, reason: token.reason };

  const raw = Buffer.from(buildMimeMessage(input), "utf8").toString("base64url");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const response = await fetchImpl(SEND_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ raw }),
      signal: controller.signal,
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return { ok: false, kind: "unauthorized", reason: `Gmailの認可に失敗しました（${response.status}）` };
      }
      if (response.status === 400) {
        return { ok: false, kind: "rejected", reason: "Gmailがメッセージの内容を受け付けませんでした" };
      }
      return { ok: false, kind: "failed", reason: `Gmailへの送信に失敗しました（${response.status}）` };
    }

    const payload = (await response.json()) as { id?: unknown };
    if (typeof payload.id !== "string" || !payload.id) {
      return { ok: false, kind: "failed", reason: "Gmailの送信応答にmessageIdが含まれていません" };
    }
    return { ok: true, messageId: payload.id };
  } catch (cause) {
    const aborted = cause instanceof Error && cause.name === "AbortError";
    return {
      ok: false,
      kind: "failed",
      reason: aborted ? "Gmailへの送信がタイムアウトしました（送信されたかは不明です）" : "Gmailへ接続できませんでした",
    };
  } finally {
    clearTimeout(timeout);
  }
}
