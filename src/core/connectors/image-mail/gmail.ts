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

/** 送信元・宛先・BCC。画像メール（aide#230）・業界ニュース週報メール（aide#257）で共通の形。 */
export interface MailAddresses {
  /** `From` に載せる値（組み立て済み）。未設定なら null で、Gmailが認可済みアカウントのアドレスで補完する。 */
  from: string | null;
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

/** `user@example.com` の形か（表示名・山括弧を含まない裸のアドレス）。 */
function isPlainAddress(address: string): boolean {
  return /^[^\s<>@,;:"]+@[^\s<>@,;:."]+(\.[^\s<>@,;:."]+)+$/.test(address);
}

/**
 * RFC 2822 の表示名を組み立てる。非ASCIIはRFC 2047でエンコードし、
 * ASCIIでも特殊文字（`.` や `,` など）を含むなら引用符でくくる。
 */
function formatDisplayName(name: string): string {
  if (!/^[\x20-\x7e]*$/.test(name)) return encodeWord(name);
  if (!/[()<>@,;:\\".[\]]/.test(name)) return name;
  return `"${name.replace(/([\\"])/g, "\\$1")}"`;
}

/**
 * `AIDE_IMAGE_MAIL_FROM` の値から `From` ヘッダに載せる文字列を作る（aide#238）。
 * `user@example.com` と `表示名 <user@example.com>` の両方を受け付け、形式が不正なら null。
 *
 * **改行を含む値は必ず弾く。** ヘッダに素通しすると任意のヘッダを差し込まれる
 * （現状の値の出どころは環境変数だけだが、検査はここで閉じておく）。
 */
export function formatFromAddress(value: string): string | null {
  if (/[\r\n]/.test(value)) return null;
  const trimmed = value.trim();
  const match = /^(.*)<([^<>]*)>$/.exec(trimmed);
  const displayName = match ? match[1]!.trim() : "";
  const address = (match ? match[2]! : trimmed).trim();
  if (!isPlainAddress(address)) return null;
  if (!displayName) return address;
  return `${formatDisplayName(displayName)} <${address}>`;
}

/**
 * 送信元・宛先・BCCを環境変数から読む。設定が足りない・形式が不正なら理由を返す
 * （呼び出し元はそのまま503のメッセージに使う）。`envPrefix` は `AIDE_IMAGE_MAIL` /
 * `AIDE_NEWS_MAIL` のように、口ごとに別の環境変数を参照するための接頭辞。
 */
function loadMailAddresses(envPrefix: string): { addresses: MailAddresses } | { error: string } {
  const to = splitAddresses(process.env[`${envPrefix}_TO`]);
  if (to.length === 0) {
    return { error: `送信先（${envPrefix}_TO）が未設定のため利用できません` };
  }

  const rawFrom = (process.env[`${envPrefix}_FROM`] ?? "").trim();
  let from: string | null = null;
  if (rawFrom !== "") {
    from = formatFromAddress(rawFrom);
    if (from === null) {
      // 値そのものは出さない（設定ミスの指摘に実値は要らない）。
      return {
        error: `送信元（${envPrefix}_FROM）の形式が不正です。user@example.com または 表示名 <user@example.com> の形で指定してください`,
      };
    }
  }

  return { addresses: { from, to, bcc: splitAddresses(process.env[`${envPrefix}_BCC`]) } };
}

export function loadImageMailAddresses(): { addresses: MailAddresses } | { error: string } {
  return loadMailAddresses("AIDE_IMAGE_MAIL");
}

/** 業界ニュース週報メール（aide#257）の送信元・宛先・BCC。画像メールとは別の環境変数を使う。 */
export function loadNewsMailAddresses(): { addresses: MailAddresses } | { error: string } {
  return loadMailAddresses("AIDE_NEWS_MAIL");
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

/** RFC 2047: 非ASCIIのヘッダ値（件名・表示名）を `=?UTF-8?B?...?=` へエンコードする。 */
function encodeWord(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** RFC 2045: base64本文は76文字ごとに改行する。 */
function chunkBase64(base64: string): string {
  return (base64.match(/.{1,76}/g) ?? []).join("\r\n");
}

export interface BuildMimeMessageInput {
  /** 送信元（`formatFromAddress()` を通した値）。省略するとGmailが認可済みアカウントのアドレスで補完する。 */
  from?: string | undefined;
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
 * 構成する（quoted-printableとの使い分けをせず実装を単純にする）。
 *
 * **`From` は指定されたときだけ書く**（aide#238）。書かなければGmail APIが認可済みアカウントの
 * アドレスを補完する。Gmailは認可済みアカウント本人か、Gmailの設定で確認済みの別アドレス
 * （send-as alias）しか `From` に許さないため、それ以外を書くと400（`rejected`）で返ってくる。
 */
export function buildMimeMessage(input: BuildMimeMessageInput): string {
  const boundary = `----aide-image-mail-${randomBytes(16).toString("hex")}`;
  const headers = [
    ...(input.from ? [`From: ${input.from}`] : []),
    `To: ${input.to.join(", ")}`,
    ...(input.bcc.length > 0 ? [`Bcc: ${input.bcc.join(", ")}`] : []),
    `Subject: ${encodeWord(input.subject)}`,
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

export interface BuildAlternativeMimeMessageInput {
  /** 送信元（`formatFromAddress()` を通した値）。省略するとGmailが認可済みアカウントのアドレスで補完する。 */
  from?: string | undefined;
  to: string[];
  bcc: string[];
  /** 接頭辞を含め呼び出し元が組み立て済みの件名をそのまま使う（業界ニュース週報メール。aide#257）。 */
  subject: string;
  bodyText: string;
  bodyHtml: string;
}

/**
 * RFC 2822 のメッセージ本文（`multipart/alternative`）を組み立てる（業界ニュース週報メール。aide#257）。
 *
 * `buildMimeMessage()` の `multipart/mixed`（添付あり）とは違い、テキストとHTMLの2表現を
 * 同じ内容として並べる。**HTMLより先にテキストを置く**——`multipart/alternative` はRFC 2046の
 * 規定どおり「後のパートほど優先して表示される」ため、HTML非対応のメールクライアントに
 * テキストを見せるにはこの順序にする必要がある。
 */
export function buildAlternativeMimeMessage(input: BuildAlternativeMimeMessageInput): string {
  const boundary = `----aide-news-mail-${randomBytes(16).toString("hex")}`;
  const headers = [
    ...(input.from ? [`From: ${input.from}`] : []),
    `To: ${input.to.join(", ")}`,
    ...(input.bcc.length > 0 ? [`Bcc: ${input.bcc.join(", ")}`] : []),
    `Subject: ${encodeWord(input.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];

  const textPart = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    chunkBase64(Buffer.from(input.bodyText, "utf8").toString("base64")),
  ].join("\r\n");

  const htmlPart = [
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    chunkBase64(Buffer.from(input.bodyHtml, "utf8").toString("base64")),
  ].join("\r\n");

  return [headers.join("\r\n"), "", textPart, htmlPart, `--${boundary}--`, ""].join("\r\n");
}

export type GmailSendOutcome =
  | { ok: true; messageId: string }
  | { ok: false; kind: "unauthorized" | "rejected" | "failed"; reason: string };

/**
 * トークン取得済みの状態から、組み立て済みのRFC 2822メッセージをGmail APIへ送る。
 * `sendGmailMessage` と `sendGmailAlternativeMessage` の共通部分（`buildMimeMessage` /
 * `buildAlternativeMimeMessage` のどちらで組み立てたかだけが違う）。
 */
async function sendRawMessage(accessToken: string, raw: string, fetchImpl: typeof fetch): Promise<GmailSendOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const response = await fetchImpl(SEND_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
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

/**
 * Gmail APIでメッセージを送信する（画像メール。`multipart/mixed`）。
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
  return sendRawMessage(token.accessToken, raw, fetchImpl);
}

/**
 * Gmail APIでメッセージを送信する（業界ニュース週報メール。`multipart/alternative`。aide#257）。
 * `kind` の意味は `sendGmailMessage()` と同じ。
 */
export async function sendGmailAlternativeMessage(
  credentials: GmailCredentials,
  input: BuildAlternativeMimeMessageInput,
  fetchImpl: typeof fetch = fetch,
): Promise<GmailSendOutcome> {
  const token = await fetchAccessToken(credentials, fetchImpl);
  if (!token.ok) return { ok: false, kind: token.kind, reason: token.reason };

  const raw = Buffer.from(buildAlternativeMimeMessage(input), "utf8").toString("base64url");
  return sendRawMessage(token.accessToken, raw, fetchImpl);
}
