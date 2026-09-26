/**
 * IssueDeck 画像アップロードのコネクタ（#449）。
 *
 * IssueDeck の `POST /api/issues/images` はもともとログインCookie専用で、ChatGPT・Claude から
 * 届く経路が無かった。**Bearer の共有シークレット（`AIDE_ISSUE_DECK_UPLOAD_TOKEN`）で受ける口を
 * IssueDeck 側に足してもらい、AIDEが中継する。** シークレットはAIDEだけが持ち、MCPの入力・出力・
 * ログへは出さない。`fetch`・`FormData` しか使わないので実行時依存も増えない。
 *
 * **検査は IssueDeck と同じ条件をAIDE側でも先に行う**（形式はpng/jpeg/gif/webp/svg・10MBまで）。
 * 弾くだけのために往復させず、`dryRun` でも本番と同じ検査を通すため。バイト列の先頭も確かめ、
 * MIMEを名乗るだけの別の中身（HTMLなど）を送らない。
 */

/** IssueDeck の `MAX_FILE_SIZE` と同じ。 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** 受け付けるMIMEと、IssueDeck が保存に使う拡張子。 */
export const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

const UPLOAD_TIMEOUT_MS = 30_000;
/** SVGかどうかを見る先頭のバイト数。IssueDeck の `SVG_HEAD_SCAN_BYTES` と同程度。 */
const SVG_HEAD_BYTES = 1024;

export interface IssueDeckUploadConfig {
  baseUrl: string;
  token: string;
}

/** どちらかが無ければ null（＝送信しない）。戻り値はログ・応答へ出さない。 */
export function readIssueDeckUploadConfig(): IssueDeckUploadConfig | null {
  const baseUrl = process.env["AIDE_ISSUE_DECK_URL"];
  const token = process.env["AIDE_ISSUE_DECK_UPLOAD_TOKEN"];
  if (!baseUrl || !token) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token };
}

export interface ValidImage {
  bytes: Buffer;
  mimeType: string;
  extension: string;
}

function startsWith(bytes: Buffer, signature: number[], offset = 0): boolean {
  return signature.every((value, index) => bytes[offset + index] === value);
}

function matchesMime(bytes: Buffer, mimeType: string): boolean {
  switch (mimeType) {
    case "image/png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case "image/gif":
      return startsWith(bytes, [0x47, 0x49, 0x46, 0x38]);
    case "image/webp":
      return startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8);
    case "image/svg+xml":
      return /<svg[\s>]/i.test(bytes.subarray(0, SVG_HEAD_BYTES).toString("utf8"));
    default:
      return false;
  }
}

/** 検査に通れば画像、通らなければ利用者へ返せる理由の文字列。 */
export function validateImage(dataBase64: unknown, mimeType: unknown): ValidImage | string {
  if (typeof mimeType !== "string" || !(mimeType in EXTENSION_BY_MIME)) {
    return `mimeType は ${Object.keys(EXTENSION_BY_MIME).join(" / ")} のいずれかで指定してください`;
  }
  if (typeof dataBase64 !== "string" || !dataBase64.trim()) return "dataBase64 は必須です";

  // `data:image/png;base64,` の接頭辞と改行・空白は許す（コピーの持ち回りで付きやすい）。
  const cleaned = dataBase64.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned) || cleaned.length % 4 === 1) {
    return "dataBase64 が base64 として読めません";
  }
  // デコード前に大きさを見積もり、巨大な入力でメモリを使わない。
  if (Math.floor((cleaned.length * 3) / 4) > MAX_IMAGE_BYTES) {
    return `画像が大きすぎます（${MAX_IMAGE_BYTES / 1024 / 1024}MBまで）`;
  }

  const bytes = Buffer.from(cleaned, "base64");
  if (bytes.length === 0) return "dataBase64 が空です";
  if (bytes.length > MAX_IMAGE_BYTES) return `画像が大きすぎます（${MAX_IMAGE_BYTES / 1024 / 1024}MBまで）`;
  if (!matchesMime(bytes, mimeType)) return `中身が ${mimeType} の画像として読めません（mimeType と実際の形式が一致しません）`;

  return { bytes, mimeType, extension: EXTENSION_BY_MIME[mimeType]! };
}

export type UploadOutcome =
  | { ok: true; url: string; filename: string }
  | { ok: false; httpStatus: number | null; reason: string };

/** 外へ出してよい粒度の理由に丸める（例外の message にはURLが載りうる）。 */
function describeStatus(status: number): string {
  if (status === 401) return "IssueDeckがHTTP 401を返しました（アップロード用シークレットが一致しない、または受け口が未対応）";
  if (status === 413) return "IssueDeckが画像を大きすぎると判断しました（HTTP 413）";
  if (status === 415) return "IssueDeckが画像の形式を受け付けませんでした（HTTP 415）";
  return `IssueDeckがHTTP ${status}を返しました`;
}

export async function uploadImage(config: IssueDeckUploadConfig, image: ValidImage): Promise<UploadOutcome> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(image.bytes)], { type: image.mimeType }), `image.${image.extension}`);

  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/api/issues/images`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}` },
      body: form,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (cause) {
    const kind = cause instanceof Error ? cause.name : "Error";
    return { ok: false, httpStatus: null, reason: `IssueDeckへ届きませんでした（${kind}）` };
  }

  if (!response.ok) return { ok: false, httpStatus: response.status, reason: describeStatus(response.status) };

  const body = (await response.json().catch(() => null)) as { url?: unknown; filename?: unknown } | null;
  if (!body || typeof body.url !== "string" || typeof body.filename !== "string") {
    return { ok: false, httpStatus: response.status, reason: "IssueDeckの応答から画像のURLを読み取れませんでした" };
  }
  // IssueDeck が返す `url` はリクエストの Host から組み立てられる。内部アドレスで繋ぐと画面で開けない
  // URLになるため使わず、`filename` と `AIDE_ISSUE_DECK_URL`（公開URL）から組み立て直す。
  if (!/^[0-9a-f-]{36}\.(png|jpg|gif|webp|svg)$/.test(body.filename)) {
    return { ok: false, httpStatus: response.status, reason: "IssueDeckの応答のファイル名が想定と違います" };
  }
  return { ok: true, url: `${config.baseUrl}/api/issues/images/${body.filename}`, filename: body.filename };
}
