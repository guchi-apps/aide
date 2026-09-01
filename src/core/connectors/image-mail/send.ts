import { abandonImageMail, beginImageMail, completeImageMail } from "./idempotency.ts";
import { type GmailCredentials, type ImageMailAddresses, sendGmailMessage } from "./gmail.ts";
import { recordImageMailLog } from "./log.ts";

/**
 * 冪等性チェック→Gmail送信→記録、をまとめるオーケストレーション層（aide#230）。
 * `src/core/connectors/zaim/write.ts` の `createZaimPayment()` と同じ構図。
 */

export interface SendImageMailInput {
  idempotencyKey: string;
  title: string;
  imageCount: number;
  width: 1200 | 900 | 600;
  zip: Buffer;
}

export type SendImageMailOutcome =
  | { ok: true; messageId: string; duplicated: boolean }
  | { ok: false; kind: "conflict" | "unauthorized" | "rejected" | "failed"; reason: string };

function buildBodyText(input: Pick<SendImageMailInput, "title" | "imageCount" | "width">): string {
  return [`タイトル: ${input.title}`, `枚数: ${input.imageCount}枚`, `横幅: ${input.width}px`].join("\n");
}

export async function sendImageMail(
  credentials: GmailCredentials,
  addresses: ImageMailAddresses,
  input: SendImageMailInput,
  fetchImpl: typeof fetch = fetch,
): Promise<SendImageMailOutcome> {
  const begun = await beginImageMail(input.idempotencyKey);
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
  const outcome = await sendGmailMessage(
    credentials,
    {
      from: addresses.from ?? undefined,
      to: addresses.to,
      bcc: addresses.bcc,
      subject: `[画像] ${input.title}`,
      bodyText: buildBodyText(input),
      attachment: { filename: "images.zip", contentType: "application/zip", data: input.zip },
    },
    fetchImpl,
  );

  if (!outcome.ok) {
    // 送信されていないことが確実な場合だけ記録を消す。再送で二重送信になりうる `failed` では残す。
    if (outcome.kind === "unauthorized" || outcome.kind === "rejected") {
      await abandonImageMail(input.idempotencyKey);
    }
    await recordImageMailLog({
      ok: false,
      imageCount: input.imageCount,
      width: input.width,
      zipBytes: input.zip.length,
      messageId: null,
      reason: outcome.reason,
      ms: Date.now() - startedAt,
    });
    return { ok: false, kind: outcome.kind, reason: outcome.reason };
  }

  await completeImageMail(input.idempotencyKey, outcome.messageId);
  await recordImageMailLog({
    ok: true,
    imageCount: input.imageCount,
    width: input.width,
    zipBytes: input.zip.length,
    messageId: outcome.messageId,
    reason: null,
    ms: Date.now() - startedAt,
  });
  return { ok: true, messageId: outcome.messageId, duplicated: false };
}
