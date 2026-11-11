import { resolve } from "node:path";
import { createRecordFile } from "../../record-file.ts";
import { DATA_DIR } from "../../paths.ts";

/**
 * `idempotencyKey` による二重送信防止（aide#841）。
 *
 * `src/core/connectors/image-mail/idempotency.ts`（aide#230）をそのまま写している——
 * 中身も同じく `idempotencyKey`・`messageId`・時刻の3つだけで、work-relay側のメモの
 * 内容は書かない。
 */

const MAX_RECORDS = 500;

export const TEXT_MAIL_IDEMPOTENCY_LOG_PATH = process.env["AIDE_TEXT_MAIL_IDEMPOTENCY_LOG_PATH"]
  ? resolve(process.env["AIDE_TEXT_MAIL_IDEMPOTENCY_LOG_PATH"])
  : resolve(DATA_DIR, "text-mail-idempotency.json");

export interface TextMailIdempotencyRecord {
  idempotencyKey: string;
  /** null は「送ったが結果が確定していない」（打ち切り・通信断）。 */
  messageId: string | null;
  at: string;
}

export type BeginResult =
  | { status: "new" }
  | { status: "done"; messageId: string }
  | { status: "unresolved"; at: string };

const file = createRecordFile<TextMailIdempotencyRecord>(TEXT_MAIL_IDEMPOTENCY_LOG_PATH, MAX_RECORDS);

/** 送ってよいかを判定し、通す場合は「結果不明」の記録を先に置く（送る前に記録するのが要点）。 */
export function beginTextMail(idempotencyKey: string, now: Date = new Date()): Promise<BeginResult> {
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
export function completeTextMail(idempotencyKey: string, messageId: string, now: Date = new Date()): Promise<void> {
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
export function abandonTextMail(idempotencyKey: string): Promise<void> {
  return file.update((records) => {
    const remaining = records.filter((record) => record.idempotencyKey !== idempotencyKey);
    if (remaining.length === records.length) return { result: undefined, write: false };
    records.splice(0, records.length, ...remaining);
    return { result: undefined, write: true };
  });
}
