import type { IncomingMessage, ServerResponse } from "node:http";
import { clientKey, FAILURE_DELAY_MS, lockedFor, recordFailure, recordSuccess } from "../auth/ratelimit.ts";
import { loadGmailCredentials, loadNewsMailAddresses } from "../core/connectors/image-mail/gmail.ts";
import { sendNewsMail, type SendNewsMailInput, type SendNewsMailOutcome } from "../core/connectors/news-mail/send.ts";
import { bearerToken, secretMatches } from "./secret.ts";

/**
 * 業界ニュース週報メール送信の内部API（aide#257。research-desk#110の一部）。
 *
 * Research Desk**のサーバー**（guchi-apps/research-desk#111）が、画面で組み立てた週報の
 * HTML/テキスト本文を `application/json` で中継してくる。サーバー間通信のため、
 * `/api/zaim/payment` と同じくCORS対応は不要。
 *
 * `src/api/image-mail.ts`（aide#230）と同じ作りだが、**添付ファイルではなくHTML/テキストの
 * 本文を受け取る**点が違う。認証・応答の形も画像メールに合わせる。
 *
 * 認証は共有シークレット1本（`AIDE_NEWS_MAIL_TOKEN`）。**`AIDE_IMAGE_MAIL_TOKEN` とは別の値**
 * にする——片方を失効させてももう片方の口が止まらないようにするため。
 *
 * **件名はリクエストの `subject` をそのまま使う。** 画像メールは件名をAIDE側で固定するが
 * （`[画像] {title}`）、こちらは接頭辞 `[業界ニュース] ` を含めてResearch Desk側で組み立て済み。
 * 送信元・宛先・BCCだけをAIDE側の環境変数で固定し、リクエストのどの項目からも上書きできない
 * ようにする。
 *
 * **応答のエラーフィールドは `message`。** Research Desk側が `response.ok` でない場合に
 * 返ってきた `message` をそのまま画面へ出す実装のため、画像メールと合わせる。
 */

/** 本文の目安（記事30件で200KB程度）に、JSON全体・エスケープ分の余裕を足した上限。 */
const MAX_BODY_BYTES = 1_500_000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
/** 件名は接頭辞込みでResearch Desk側が組み立てるが、ヘッダに載る値として長すぎないことだけ確かめる。 */
const MAX_SUBJECT_LENGTH = 500;

function json(res: ServerResponse, status: number, body: unknown): void {
  res
    .writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
    .end(JSON.stringify(body));
}

export function newsMailToken(): string | null {
  return process.env["AIDE_NEWS_MAIL_TOKEN"] || null;
}

/** 認証を通す。通れば true。通らなければ応答を書き終えて false（`image-mail.ts` の `authorize()` と同じ形）。 */
async function authorize(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const expected = newsMailToken();
  if (!expected) {
    json(res, 503, { ok: false, message: "AIDE_NEWS_MAIL_TOKEN が未設定のため利用できません" });
    return false;
  }

  const key = `news-mail:${clientKey(req)}`;
  const locked = lockedFor(key);
  if (locked !== null) {
    json(res, 429, { ok: false, message: `試行回数の上限に達しています。${locked}秒後に再試行してください` });
    return false;
  }

  const presented = bearerToken(req);
  if (!presented || !secretMatches(presented, expected)) {
    recordFailure(key);
    console.warn(`[news-mail] 認証失敗: POST /api/news-mail/send from=${key}`);
    await new Promise((resolve) => setTimeout(resolve, FAILURE_DELAY_MS));
    json(res, 401, { ok: false, message: "unauthorized" });
    return false;
  }
  recordSuccess(key);
  return true;
}

/** JSONボディを読む。上限を超える・パースできない場合は null を返し、応答は書き終えている。 */
async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<unknown | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      json(res, 413, { ok: false, message: "payload too large" });
      return null;
    }
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    json(res, 400, { ok: false, message: "invalid json" });
    return null;
  }
}

function normalizeNewsMailInput(body: unknown): { input: SendNewsMailInput } | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "リクエストボディが不正です" };
  const record = body as Record<string, unknown>;

  const idempotencyKey = typeof record["idempotencyKey"] === "string" ? record["idempotencyKey"].trim() : "";
  if (!idempotencyKey) return { error: "idempotencyKey は必須です" };
  if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    return { error: `idempotencyKey は ${MAX_IDEMPOTENCY_KEY_LENGTH} 文字以内で指定してください` };
  }

  const subject = typeof record["subject"] === "string" ? record["subject"] : "";
  if (!subject.trim()) return { error: "subject は必須です" };
  if (subject.length > MAX_SUBJECT_LENGTH) return { error: `subject は ${MAX_SUBJECT_LENGTH} 文字以内で指定してください` };
  if (/[\r\n]/.test(subject)) return { error: "subject に改行を含めることはできません" };

  const bodyText = typeof record["bodyText"] === "string" ? record["bodyText"] : "";
  if (!bodyText) return { error: "bodyText は必須です" };

  const bodyHtml = typeof record["bodyHtml"] === "string" ? record["bodyHtml"] : "";
  if (!bodyHtml) return { error: "bodyHtml は必須です" };

  const articleCount = Number(record["articleCount"]);
  if (!Number.isInteger(articleCount) || articleCount < 0) {
    return { error: "articleCount は0以上の整数で指定してください" };
  }

  return { input: { idempotencyKey, subject, bodyText, bodyHtml, articleCount } };
}

/** 失敗の種類をHTTPステータスへ移す（`image-mail.ts` の `statusFor()` と同じ考え方）。 */
function statusFor(kind: Exclude<SendNewsMailOutcome, { ok: true }>["kind"]): number {
  if (kind === "conflict") return 409;
  if (kind === "unauthorized") return 503; // AIDE側のGmail資格情報の問題。呼び出し元の入力とは無関係
  if (kind === "rejected") return 422; // Gmailが内容を拒んだ。送信されていない
  return 502; // failed: タイムアウト・5xx・通信断。送信されたか不明
}

/**
 * `POST /api/news-mail/send`
 *
 * 業界ニュース週報メールをGmailで送信する。`idempotencyKey` が同じ再送はGmailへ送らず、
 * 前回の `messageId` を `duplicated: true` で返す。
 */
export async function handleNewsMailSend(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
  const addresses = loadNewsMailAddresses();
  if ("error" in addresses) {
    json(res, 503, { ok: false, message: addresses.error });
    return;
  }

  const contentType = String(req.headers["content-type"] ?? "");
  if (!contentType.includes("application/json")) {
    json(res, 400, { ok: false, message: "application/json で送信してください" });
    return;
  }

  const body = await readJsonBody(req, res);
  if (body === null) return;

  const normalized = normalizeNewsMailInput(body);
  if ("error" in normalized) {
    json(res, 400, { ok: false, message: normalized.error });
    return;
  }

  const outcome = await sendNewsMail(credentials, addresses.addresses, normalized.input);
  if (!outcome.ok) {
    json(res, statusFor(outcome.kind), { ok: false, message: outcome.reason });
    return;
  }

  json(res, 200, { ok: true, messageId: outcome.messageId, duplicated: outcome.duplicated });
}
