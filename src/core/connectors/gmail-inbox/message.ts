/**
 * Gmail API（`users.messages.get`）の応答を、画面で扱う形へ畳む（#770）。
 *
 * Gmail API はヘッダの値をデコード済み（RFC 2047 を解いたUTF-8）で返すが、**本文（`body.data`）は
 * 転送エンコーディングを解いただけのバイト列**で、文字コードは各パートの `Content-Type` の
 * `charset` に従う。日本語のメールには今も ISO-2022-JP・Shift_JIS が混ざるため、UTF-8決め打ちで
 * 読むと文字化けする。Node の `TextDecoder`（full-icu）で charset どおりに読み、知らない名前なら
 * UTF-8へ落とす。
 *
 * この層はネットワークに触れない純粋関数だけを置く。テストはここに当てる。
 */

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailPartBody {
  size?: number;
  data?: string;
  attachmentId?: string;
}

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: GmailPartBody;
  parts?: GmailPart[];
}

/** `users.messages.get` の応答のうち、使う部分だけ。 */
export interface GmailApiMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

/** 一覧の1行。 */
export interface MailSummary {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  snippet: string;
  /** 受信日時（エポックミリ秒）。取れなければ null。 */
  receivedAt: number | null;
  labelIds: string[];
  unread: boolean;
  starred: boolean;
}

export interface MailAttachment {
  filename: string;
  mimeType: string;
  size: number;
}

/** 本文画面の1通。 */
export interface MailDetail extends MailSummary {
  to: string;
  cc: string;
  /** HTMLの本文。無ければ null（テキストだけのメール）。 */
  html: string | null;
  /** テキストの本文。無ければ null。 */
  text: string | null;
  attachments: MailAttachment[];
}

function header(headers: GmailHeader[] | undefined, name: string): string {
  const lower = name.toLowerCase();
  return headers?.find((h) => h.name.toLowerCase() === lower)?.value ?? "";
}

/**
 * `snippet` はHTMLの文字参照（`&#39;`・`&amp;` など）を含んだまま返ってくる。
 * 画面では改めてエスケープするので、ここでは平文へ戻すだけにする。
 */
export function decodeSnippet(snippet: string): string {
  return snippet
    .replace(/&#(\d+);/g, (_, code: string) => safeFromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => safeFromCodePoint(parseInt(code, 16)))
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&");
}

function safeFromCodePoint(code: number): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
}

/** `Content-Type` ヘッダから charset を取り出す。無ければ null。 */
export function charsetOf(contentType: string): string | null {
  const match = /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType);
  return match ? match[1]!.toLowerCase() : null;
}

/**
 * 本文の先頭に書かれた `<meta charset=...>`・`<meta http-equiv="Content-Type" content="...; charset=...">`
 * から文字コードを拾う。`Content-Type` ヘッダに charset が無いHTMLメールの救済用。
 */
export function sniffMetaCharset(bytes: Uint8Array): string | null {
  const head = Buffer.from(bytes.subarray(0, 2048)).toString("latin1");
  const match = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_:.-]+)/i.exec(head);
  return match ? match[1]!.toLowerCase() : null;
}

function tryDecode(label: string, bytes: Uint8Array): string | null {
  try {
    return new TextDecoder(label, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * base64url（Gmail API の `body.data`）を、指定の文字コードで文字列へ戻す。
 * charset が無い・知らない名前のときは、HTMLの meta → ISO-2022-JP（ESCを含むとき）→ UTF-8 → 日本語の文字コード
 * （ISO-2022-JP → Shift_JIS）の順に、エラー無く読めたものを使う。
 */
export function decodeBody(data: string, charset: string | null): string {
  const bytes = Buffer.from(data.replaceAll("-", "+").replaceAll("_", "/"), "base64");
  const declared = charset ?? sniffMetaCharset(bytes);
  if (declared) {
    const out = tryDecode(declared, bytes);
    if (out !== null) return out;
  }
  // ISO-2022-JP は全バイトが7bitに収まりUTF-8としても「読めてしまう」ので、ESC があれば先に試す。
  const jis = bytes.includes(0x1b) ? tryDecode("iso-2022-jp", bytes) : null;
  if (jis !== null) return jis;
  const utf8 = tryDecode("utf-8", bytes);
  if (utf8 !== null) return utf8;
  const sjis = tryDecode("shift_jis", bytes);
  if (sjis !== null) return sjis;
  return new TextDecoder("utf-8").decode(bytes);
}

function isAttachment(part: GmailPart): boolean {
  if (part.filename) return true;
  return /^\s*attachment/i.test(header(part.headers, "Content-Disposition"));
}

interface Collected {
  html: string | null;
  text: string | null;
  attachments: MailAttachment[];
}

/**
 * パートの木をたどり、最初に見つかった text/html と text/plain、添付の一覧を集める。
 * `multipart/alternative` は両方を持つので、画面側でHTMLを優先して出す。
 */
function collect(part: GmailPart, out: Collected): void {
  const mimeType = (part.mimeType ?? "").toLowerCase();
  if (part.parts?.length) {
    for (const child of part.parts) collect(child, out);
    return;
  }
  if (isAttachment(part)) {
    out.attachments.push({
      filename: part.filename || "(名前なし)",
      mimeType: part.mimeType ?? "application/octet-stream",
      size: part.body?.size ?? 0,
    });
    return;
  }
  const data = part.body?.data;
  if (!data) return;
  const charset = charsetOf(header(part.headers, "Content-Type"));
  if (mimeType === "text/html" && out.html === null) out.html = decodeBody(data, charset);
  else if (mimeType === "text/plain" && out.text === null) out.text = decodeBody(data, charset);
}

export function toSummary(message: GmailApiMessage): MailSummary {
  const headers = message.payload?.headers;
  const labelIds = message.labelIds ?? [];
  const internal = Number(message.internalDate);
  return {
    id: message.id,
    threadId: message.threadId ?? message.id,
    from: header(headers, "From"),
    subject: header(headers, "Subject"),
    snippet: decodeSnippet(message.snippet ?? ""),
    receivedAt: Number.isFinite(internal) && internal > 0 ? internal : null,
    labelIds,
    unread: labelIds.includes("UNREAD"),
    starred: labelIds.includes("STARRED"),
  };
}

export function toDetail(message: GmailApiMessage): MailDetail {
  const collected: Collected = { html: null, text: null, attachments: [] };
  if (message.payload) collect(message.payload, collected);
  const headers = message.payload?.headers;
  return {
    ...toSummary(message),
    to: header(headers, "To"),
    cc: header(headers, "Cc"),
    ...collected,
  };
}

/** `"表示名" <user@example.com>` から、一覧に出す短い名前（表示名、無ければアドレス）を取る。 */
export function displayName(from: string): string {
  const match = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from);
  if (!match) return from.trim();
  return match[1]!.trim() || match[2]!.trim();
}
