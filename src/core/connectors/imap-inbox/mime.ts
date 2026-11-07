import type { GmailHeader, GmailPart } from "../gmail-inbox/message.ts";

/**
 * IMAPで取った生のメール（RFC 5322）を、Gmail API の `payload` と同じ形（`GmailPart`）へ畳む（#782）。
 * こうしておくと本文の文字コード判定・パート走査は既存の `gmail-inbox/message.ts`（`toDetail`）を
 * そのまま使える。ネットワークに触れない純粋関数だけを置く。
 *
 * 持つのは画面に出すのに要る範囲だけ: ヘッダの折り返し解除・RFC 2047 のデコード・multipart の分割・
 * base64 / quoted-printable の転送エンコーディング解除。
 */

const MAX_DEPTH = 8;

function splitHeadBody(raw: Buffer): { head: string; body: Buffer } {
  const crlf = raw.indexOf("\r\n\r\n");
  const lf = raw.indexOf("\n\n");
  let at = -1;
  let sep = 0;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) {
    at = crlf;
    sep = 4;
  } else if (lf !== -1) {
    at = lf;
    sep = 2;
  }
  if (at === -1) return { head: raw.toString("latin1"), body: Buffer.alloc(0) };
  return { head: raw.subarray(0, at).toString("latin1"), body: raw.subarray(at + sep) };
}

/** 折り返し（行頭の空白）を解いて、ヘッダの一覧にする。 */
export function parseHeaders(head: string): GmailHeader[] {
  const headers: GmailHeader[] = [];
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && headers.length > 0) {
      headers[headers.length - 1]!.value += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    headers.push({ name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() });
  }
  return headers;
}

function headerValue(headers: GmailHeader[], name: string): string {
  const lower = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === lower)?.value ?? "";
}

export function decodeQuotedPrintable(input: Buffer): Buffer {
  const text = input.toString("latin1").replace(/=\r?\n/g, "");
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x3d && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) {
      out.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out.push(c & 0xff);
    }
  }
  return Buffer.from(out);
}

function decodeTransfer(body: Buffer, encoding: string): Buffer {
  switch (encoding.trim().toLowerCase()) {
    case "base64":
      return Buffer.from(body.toString("latin1").replace(/\s+/g, ""), "base64");
    case "quoted-printable":
      return decodeQuotedPrintable(body);
    default:
      return body;
  }
}

function decodeWithCharset(bytes: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** RFC 2047（`=?UTF-8?B?...?=`）を解く。ヘッダの件名・差出人・宛先に使う。 */
export function decodeMimeWords(value: string): string {
  const joined = value.replace(/(\?=)\s+(=\?)/g, "$1$2");
  return joined.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, charset: string, enc: string, text: string) => {
    const bytes =
      enc.toLowerCase() === "b"
        ? Buffer.from(text, "base64")
        : decodeQuotedPrintable(Buffer.from(text.replaceAll("_", " "), "latin1"));
    return decodeWithCharset(bytes, charset.split("*")[0]!);
  });
}

function boundaryOf(contentType: string): string | null {
  const match = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  return match ? (match[1] ?? match[2] ?? null) : null;
}

function filenameOf(headers: GmailHeader[]): string {
  const disposition = headerValue(headers, "Content-Disposition");
  const type = headerValue(headers, "Content-Type");
  const match = /filename\*?\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(disposition) ?? /name\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(type);
  return match ? decodeMimeWords(match[1] ?? match[2] ?? "") : "";
}

function splitMultipart(body: Buffer, boundary: string): Buffer[] {
  const text = body.toString("latin1");
  const marker = `--${boundary}`;
  const parts: Buffer[] = [];
  let from = text.indexOf(marker);
  while (from !== -1) {
    const lineEnd = text.indexOf("\n", from);
    if (lineEnd === -1) break;
    // 終端（`--boundary--`）に来たら終わり。
    if (text.startsWith("--", from + marker.length)) break;
    const next = text.indexOf(`\n${marker}`, lineEnd);
    const end = next === -1 ? text.length : next;
    const chunk = text.slice(lineEnd + 1, end).replace(/\r$/, "");
    parts.push(Buffer.from(chunk, "latin1"));
    if (next === -1) break;
    from = next + 1;
  }
  return parts;
}

/** 生のメールを `GmailPart` の木にする。`body.data` は転送エンコーディングを解いたバイト列の base64url。 */
export function parseMime(raw: Buffer, depth = 0): GmailPart {
  const { head, body } = splitHeadBody(raw);
  const headers = parseHeaders(head).map((h) => ({ ...h, value: h.name.toLowerCase().startsWith("content-") ? h.value : decodeMimeWords(h.value) }));
  const contentType = headerValue(headers, "Content-Type") || "text/plain";
  const mimeType = (contentType.split(";")[0] ?? "text/plain").trim().toLowerCase();
  const boundary = boundaryOf(contentType);

  if (mimeType.startsWith("multipart/") && boundary && depth < MAX_DEPTH) {
    return {
      mimeType,
      headers,
      parts: splitMultipart(body, boundary).map((chunk) => parseMime(chunk, depth + 1)),
    };
  }
  const decoded = decodeTransfer(body, headerValue(headers, "Content-Transfer-Encoding"));
  return {
    mimeType,
    headers,
    filename: filenameOf(headers),
    body: { size: decoded.length, data: decoded.toString("base64url") },
  };
}
