import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * `multipart/form-data` の最小パーサー。
 *
 * Node標準にmultipartパーサーは無く、依存ゼロの方針（README「依存関係の追加」）のもとでは
 * 自前で書く必要がある。**汎用実装は目指さない。** ここで読めればよいのは画像メール送信API
 * （aide#230）が受け取る、テキストフィールド数個 ＋ ファイルパート1個という形だけ。
 * ネストしたmultipart・`Content-Transfer-Encoding`・複数ファイルには対応しない。
 *
 * **必ずBuffer上で処理する。** ファイルパートの中身はZIPのバイナリなので、途中で
 * `toString("utf8")` を経由すると不正なUTF-8シーケンスとして文字化けし、元のバイト列へ
 * 戻せなくなる。境界の検出は `Buffer#indexOf(Buffer)` で行い、テキストとして読むのは
 * ASCIIであることが保証されているヘッダ行（`\r\n\r\n` まで）だけにする。
 */

const CRLF = Buffer.from("\r\n");
const HEADER_END = Buffer.from("\r\n\r\n");

export interface MultipartFile {
  fieldName: string;
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface ParsedMultipart {
  fields: Record<string, string>;
  file: MultipartFile | null;
}

/** `Content-Type: multipart/form-data; boundary=...` からboundaryを取り出す。無ければnull。 */
export function extractBoundary(contentType: string | undefined): string | null {
  if (!contentType) return null;
  const [mime, ...params] = contentType.split(";").map((part) => part.trim());
  if (mime?.toLowerCase() !== "multipart/form-data") return null;
  for (const param of params) {
    const eq = param.indexOf("=");
    if (eq === -1) continue;
    const key = param.slice(0, eq).trim().toLowerCase();
    if (key !== "boundary") continue;
    let value = param.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    return value || null;
  }
  return null;
}

function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of raw.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return headers;
}

/** `Content-Disposition: form-data; name="x"; filename="y"` から name / filename を取り出す。 */
function parseContentDisposition(value: string | undefined): { name: string | null; filename: string | null } {
  if (!value) return { name: null, filename: null };
  const nameMatch = /;\s*name="([^"]*)"/.exec(value);
  const filenameMatch = /;\s*filename="([^"]*)"/.exec(value);
  return { name: nameMatch?.[1] ?? null, filename: filenameMatch?.[1] ?? null };
}

/**
 * multipartの本文を分解する。
 *
 * ファイルパートはちょうど1つであることを要求する（0件・2件以上はエラー）。
 * 想定外の形はすべて `{ error }` として返し、例外は投げない（呼び出し側が400へ変換しやすいように）。
 */
export function parseMultipart(body: Buffer, boundary: string): ParsedMultipart | { error: string } {
  const delimiter = Buffer.from(`--${boundary}`);
  const fields: Record<string, string> = {};
  let file: MultipartFile | null = null;

  let searchFrom = 0;
  let start = body.indexOf(delimiter, searchFrom);
  if (start === -1) return { error: "multipartの境界が見つかりません" };

  while (true) {
    const afterDelimiter = start + delimiter.length;
    // 終端は `--boundary--`。
    if (body.subarray(afterDelimiter, afterDelimiter + 2).toString("latin1") === "--") break;

    const partStart = afterDelimiter + CRLF.length; // delimiter の直後の CRLF を読み飛ばす
    const nextDelimiter = body.indexOf(delimiter, partStart);
    if (nextDelimiter === -1) return { error: "multipartのパートが閉じられていません" };
    // 各パートは直前に CRLF を持つ（次の delimiter の2バイト前まで）。
    const partEnd = nextDelimiter - CRLF.length;

    const headerEnd = body.indexOf(HEADER_END, partStart);
    if (headerEnd === -1 || headerEnd > partEnd) return { error: "multipartのヘッダが不正です" };
    const headers = parseHeaders(body.subarray(partStart, headerEnd).toString("latin1"));
    const dataStart = headerEnd + HEADER_END.length;
    const data = body.subarray(dataStart, partEnd);

    const { name, filename } = parseContentDisposition(headers["content-disposition"]);
    if (name) {
      if (filename) {
        if (file) return { error: "ファイルパートが複数あります" };
        file = {
          fieldName: name,
          filename,
          contentType: headers["content-type"] ?? "application/octet-stream",
          data: Buffer.from(data),
        };
      } else {
        fields[name] = data.toString("utf8");
      }
    }

    searchFrom = nextDelimiter;
    start = nextDelimiter;
  }

  return { fields, file };
}

/**
 * サイズ上限つきでリクエストボディを読む。
 *
 * 上限を超えたら413を書き終えて `null` を返す（`src/api/zaim.ts` の `readBody` と同じ形）。
 */
export async function readRawBody(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes: number,
): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) {
      res
        .writeHead(413, { "Content-Type": "application/json; charset=utf-8" })
        .end(JSON.stringify({ ok: false, message: "payload too large" }));
      return null;
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
