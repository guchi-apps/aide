import { resolve } from "node:path";
import { createRecordFile } from "../../record-file.ts";
import { DATA_DIR } from "../../paths.ts";

/**
 * `idempotencyKey` による二重送信防止（aide#230）。
 *
 * Research Deskが再送してきたときに、同じ画像を2通送らないための記録。
 * 形は `src/core/connectors/zaim/idempotency.ts` をそのまま写している——違いは
 * ZaimのレコードID（数値）の代わりにGmailのmessageId（文字列）を持つだけ。
 *
 * **中身は `idempotencyKey`・`messageId`・時刻の3つだけ。** タイトルや宛先は書かない
 * （二重送信を防ぐのに要らない）。
 */

const MAX_RECORDS = 500;

export const IMAGE_MAIL_IDEMPOTENCY_LOG_PATH = process.env["AIDE_IMAGE_MAIL_IDEMPOTENCY_LOG_PATH"]
  ? resolve(process.env["AIDE_IMAGE_MAIL_IDEMPOTENCY_LOG_PATH"])
  : resolve(DATA_DIR, "image-mail-idempotency.json");

export interface ImageMailIdempotencyRecord {
  idempotencyKey: string;
  /** null は「送ったが結果が確定していない」（打ち切り・通信断）。 */
  messageId: string | null;
  at: string;
}

export type BeginResult =
  | { status: "new" }
  | { status: "done"; messageId: string }
  | { status: "unresolved"; at: string };

const file = createRecordFile<ImageMailIdempotencyRecord>(IMAGE_MAIL_IDEMPOTENCY_LOG_PATH, MAX_RECORDS);

/** 送ってよいかを判定し、通す場合は「結果不明」の記録を先に置く（送る前に記録するのが要点）。 */
export function beginImageMail(idempotencyKey: string, now: Date = new Date()): Promise<BeginResult> {
  return file.update<BeginResult>((records) => {
    const existing = records.find((record) => record.idempotencyKey === idempotencyKey);
    if (existing) {
      return {
        result:
          existing.messageId === null
            ? ({ status: "unresolved", at: existing.at } as const)
            : ({ status: "done", messageId: existing.messageId } as const),
        write: false,
      };
    }
    records.push({ idempotencyKey, messageId: null, at: now.toISOString() });
    return { result: { status: "new" } as const, write: true };
  });
}

/** 送信が確定したので messageId を書き込む。 */
export function completeImageMail(idempotencyKey: string, messageId: string, now: Date = new Date()): Promise<void> {
  return file.update((records) => {
    const existing = records.find((record) => record.idempotencyKey === idempotencyKey);
    if (existing) {
      existing.messageId = messageId;
      existing.at = now.toISOString();
    } else {
      records.push({ idempotencyKey, messageId, at: now.toISOString() });
    }
    return { result: undefined, write: true };
  });
}

/**
 * 送られなかったことが**確実な**場合に記録を消す。
 *
 * Gmailが内容を拒んだ（token失効・400/403）ときだけ呼ぶ。タイムアウト・5xxでは呼ばない
 * ——送られた可能性が残るため、消すと再送で二重送信になる。
 */
export function abandonImageMail(idempotencyKey: string): Promise<void> {
  return file.update((records) => {
    const remaining = records.filter((record) => record.idempotencyKey !== idempotencyKey);
    if (remaining.length === records.length) return { result: undefined, write: false };
    records.splice(0, records.length, ...remaining);
    return { result: undefined, write: true };
  });
}
