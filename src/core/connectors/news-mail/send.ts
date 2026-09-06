import { abandonNewsMail, beginNewsMail, completeNewsMail } from "./idempotency.ts";
import { type GmailCredentials, type MailAddresses, sendGmailAlternativeMessage } from "../image-mail/gmail.ts";
import { recordNewsMailLog } from "./log.ts";

/**
 * 冪等性チェック→Gmail送信→記録、をまとめるオーケストレーション層（aide#257）。
 * `src/core/connectors/image-mail/send.ts`（aide#230）と同じ構図。違いは、件名を
 * `[画像] {title}` のようにここで組み立てず、Research Desk側が組み立て済みの `subject` を
 * そのまま使う点（本文もHTML/テキストの2種を渡す）。
 */

export interface SendNewsMailInput {
  idempotencyKey: string;
  subject: string;
  bodyText: string;
  bodyHtml: string;
  articleCount: number;
}

export type SendNewsMailOutcome =
  | { ok: true; messageId: string; duplicated: boolean }
  | { ok: false; kind: "conflict" | "unauthorized" | "rejected" | "failed"; reason: string };

export async function sendNewsMail(
  credentials: GmailCredentials,
  addresses: MailAddresses,
  input: SendNewsMailInput,
  fetchImpl: typeof fetch = fetch,
): Promise<SendNewsMailOutcome> {
  const begun = await beginNewsMail(input.idempotencyKey);
  if (begun.status === "done") {
    return { ok: true, messageId: begun.messageId, duplicated: true };
  }
  if (begun.status === "unresolved") {
    return {
      ok: false,
      kind: "conflict",
      reason: "前回の送信結果が確定していません。Gmailの送信済みメールを確認してください",
    };
  }

  const startedAt = Date.now();
  const bodyBytes = Buffer.byteLength(input.bodyHtml, "utf8");
  const outcome = await sendGmailAlternativeMessage(
    credentials,
    {
      from: addresses.from ?? undefined,
      to: addresses.to,
      bcc: addresses.bcc,
      subject: input.subject,
      bodyText: input.bodyText,
      bodyHtml: input.bodyHtml,
    },
    fetchImpl,
  );

  if (!outcome.ok) {
    // 送信されていないことが確実な場合だけ記録を消す。再送で二重送信になりうる `failed` では残す。
    if (outcome.kind === "unauthorized" || outcome.kind === "rejected") {
      await abandonNewsMail(input.idempotencyKey);
    }
    await recordNewsMailLog({
      ok: false,
      articleCount: input.articleCount,
      bodyBytes,
      messageId: null,
      reason: outcome.reason,
      ms: Date.now() - startedAt,
    });
    return { ok: false, kind: outcome.kind, reason: outcome.reason };
  }

  await completeNewsMail(input.idempotencyKey, outcome.messageId);
  await recordNewsMailLog({
    ok: true,
    articleCount: input.articleCount,
    bodyBytes,
    messageId: outcome.messageId,
    reason: null,
    ms: Date.now() - startedAt,
  });
  return { ok: true, messageId: outcome.messageId, duplicated: false };
}
