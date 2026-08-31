import type { IncomingMessage, ServerResponse } from "node:http";
import { clientKey, FAILURE_DELAY_MS, lockedFor, recordFailure, recordSuccess } from "../auth/ratelimit.ts";
import { loadGmailCredentials, loadImageMailRecipients } from "../core/connectors/image-mail/gmail.ts";
import { sendImageMail, type SendImageMailInput, type SendImageMailOutcome } from "../core/connectors/image-mail/send.ts";
import { extractBoundary, parseMultipart, readRawBody } from "./multipart.ts";
import { bearerToken, secretMatches } from "./secret.ts";

/**
 * 画像メール送信の内部API（aide#230。research-desk#64の一部）。
 *
 * Research Desk**のサーバー**（`src/app/api/image-mail/send/route.ts`、Supabase認証は
 * あちら側で完結）が、ブラウザで圧縮・ZIP化した画像を `multipart/form-data` で中継してくる。
 * サーバー間通信のため、`/api/zaim/payment` と同じくCORS対応は不要。
 *
 * 認証は共有シークレット1本（`AIDE_IMAGE_MAIL_TOKEN`。Research Desk側の同名環境変数と
 * 同じ値）。件名は常に `[画像] {title}` で固定し、宛先・BCCも環境変数で固定する——
 * リクエストのどの項目からも上書きできない（受け入れ条件）。
 *
 * **応答のエラーフィールドは `message`。** `src/api/zaim.ts` は `error` を使うが、
 * Research Desk側は `response.ok` でない場合に返ってきた `message` をそのまま画面へ出す
 * 実装のため、ここだけは合わせる。
 */

/** ZIPの上限（2MiB）に、他フィールドとmultipartのヘッダ分の余裕を足した値。 */
const MAX_BODY_BYTES = 3 * 1024 * 1024;
const MAX_ZIP_BYTES = 2 * 1024 * 1024;
const MAX_TITLE_LENGTH = 200;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const ALLOWED_WIDTHS = [1200, 900, 600] as const;

function json(res: ServerResponse, status: number, body: unknown): void {
  res
    .writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
    .end(JSON.stringify(body));
}

export function imageMailToken(): string | null {
  return process.env["AIDE_IMAGE_MAIL_TOKEN"] || null;
}

/** 認証を通す。通れば true。通らなければ応答を書き終えて false（`zaim.ts` の `authorize()` と同じ形）。 */
async function authorize(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const expected = imageMailToken();
  if (!expected) {
    json(res, 503, { ok: false, message: "AIDE_IMAGE_MAIL_TOKEN が未設定のため利用できません" });
    return false;
  }

  const key = `image-mail:${clientKey(req)}`;
  const locked = lockedFor(key);
  if (locked !== null) {
    json(res, 429, { ok: false, message: `試行回数の上限に達しています。${locked}秒後に再試行してください` });
    return false;
  }

  const presented = bearerToken(req);
  if (!presented || !secretMatches(presented, expected)) {
    recordFailure(key);
    console.warn(`[image-mail] 認証失敗: POST /api/image-mail/send from=${key}`);
    await new Promise((resolve) => setTimeout(resolve, FAILURE_DELAY_MS));
    json(res, 401, { ok: false, message: "unauthorized" });
    return false;
  }
  recordSuccess(key);
  return true;
}

type NormalizedInput = Omit<SendImageMailInput, "zip"> & { zip: Buffer };

function normalizeImageMailInput(
  fields: Record<string, string>,
  file: { filename: string; contentType: string; data: Buffer } | null,
): { input: NormalizedInput } | { error: string } {
  const title = (fields["title"] ?? "").trim();
  if (!title) return { error: "title は必須です" };
  if (title.length > MAX_TITLE_LENGTH) return { error: `title は ${MAX_TITLE_LENGTH} 文字以内で指定してください` };

  const imageCount = Number(fields["imageCount"]);
  if (!Number.isInteger(imageCount) || imageCount <= 0) {
    return { error: "imageCount は正の整数で指定してください" };
  }

  const width = Number(fields["width"]);
  if (!(ALLOWED_WIDTHS as readonly number[]).includes(width)) {
    return { error: `width は ${ALLOWED_WIDTHS.join(" / ")} のいずれかで指定してください` };
  }

  const idempotencyKey = (fields["idempotencyKey"] ?? "").trim();
  if (!idempotencyKey) return { error: "idempotencyKey は必須です" };
  if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    return { error: `idempotencyKey は ${MAX_IDEMPOTENCY_KEY_LENGTH} 文字以内で指定してください` };
  }

  if (!file) return { error: "zip（ファイル）は必須です" };
  if (file.data.length === 0) return { error: "zip が空です" };
  if (file.data.length > MAX_ZIP_BYTES) {
    return { error: `zip は ${MAX_ZIP_BYTES} バイト以内で指定してください` };
  }

  return {
    input: {
      idempotencyKey,
      title,
      imageCount,
      width: width as 1200 | 900 | 600,
      zip: file.data,
    },
  };
}

/** 失敗の種類をHTTPステータスへ移す（`zaim.ts` の `statusFor()` と同じ考え方）。 */
function statusFor(kind: Exclude<SendImageMailOutcome, { ok: true }>["kind"]): number {
  if (kind === "conflict") return 409;
  if (kind === "unauthorized") return 503; // AIDE側のGmail資格情報の問題。呼び出し元の入力とは無関係
  if (kind === "rejected") return 422; // Gmailが内容を拒んだ。送信されていない
  return 502; // failed: タイムアウト・5xx・通信断。送信されたか不明
}

/**
 * `POST /api/image-mail/send`
 *
 * 画像ZIPをGmailで送信する。`idempotencyKey` が同じ再送はGmailへ送らず、前回の
 * `messageId` を `duplicated: true` で返す。
 */
export async function handleImageMailSend(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    res
      .writeHead(405, { "Content-Type": "application/json; charset=utf-8", Allow: "POST" })
      .end(JSON.stringify({ ok: false, message: "method not allowed" }));
    return;
  }
  if (!(await authorize(req, res))) return;

  const credentials = loadGmailCredentials();
  if (!credentials) {
    json(res, 503, { ok: false, message: "GmailのOAuth設定（AIDE_GMAIL_*）が揃っていないため利用できません" });
    return;
  }
  const recipients = loadImageMailRecipients();
  if (!recipients) {
    json(res, 503, { ok: false, message: "送信先（AIDE_IMAGE_MAIL_TO）が未設定のため利用できません" });
    return;
  }

  const boundary = extractBoundary(req.headers["content-type"]);
  if (!boundary) {
    json(res, 400, { ok: false, message: "multipart/form-data で送信してください" });
    return;
  }

  const body = await readRawBody(req, res, MAX_BODY_BYTES);
  if (body === null) return;

  const parsed = parseMultipart(body, boundary);
  if ("error" in parsed) {
    json(res, 400, { ok: false, message: parsed.error });
    return;
  }

  const normalized = normalizeImageMailInput(parsed.fields, parsed.file);
  if ("error" in normalized) {
    json(res, 400, { ok: false, message: normalized.error });
    return;
  }

  const outcome = await sendImageMail(credentials, recipients, normalized.input);
  if (!outcome.ok) {
    json(res, statusFor(outcome.kind), { ok: false, message: outcome.reason });
    return;
  }

  json(res, 200, { ok: true, messageId: outcome.messageId, duplicated: outcome.duplicated });
}
