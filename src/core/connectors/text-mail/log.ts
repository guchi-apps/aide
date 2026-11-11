import { resolve } from "node:path";
import { createRecordFile } from "../../record-file.ts";
import { DATA_DIR } from "../../paths.ts";

/**
 * 共有メモのメール送信の記録（aide#841）。
 *
 * `src/core/connectors/image-mail/log.ts`（aide#230）と目的は同じ——後から振り返るための履歴で、
 * 二重送信を防ぐための `idempotency.ts` とは分けている。
 *
 * **件名・本文は記録しない。** メモの内容を平文ログへ溜めない。
 * 本文サイズ（`bodyBytes`。HTML本文のバイト数）だけを残す。
 */

const MAX_ENTRIES = 200;

export const TEXT_MAIL_LOG_PATH = process.env["AIDE_TEXT_MAIL_LOG_PATH"]
  ? resolve(process.env["AIDE_TEXT_MAIL_LOG_PATH"])
  : resolve(DATA_DIR, "text-mail-log.json");

export interface TextMailLogEntry {
  at: string;
  ok: boolean;
  bodyBytes: number;
  messageId: string | null;
  /** 失敗理由（1行）。成功時は null。 */
  reason: string | null;
  ms: number;
}

const file = createRecordFile<TextMailLogEntry>(TEXT_MAIL_LOG_PATH, MAX_ENTRIES);

/** 記録する。呼び出し側を失敗させない（例外を投げない）。 */
export async function recordTextMailLog(entry: Omit<TextMailLogEntry, "at">, now: Date = new Date()): Promise<void> {
  try {
    await file.update((records) => {
      records.push({ ...entry, at: now.toISOString() });
      return { result: undefined, write: true };
    });
  } catch (cause) {
    console.error(
      `[text-mail] 送信記録を残せませんでした: ${cause instanceof Error ? cause.message : cause}`,
    );
  }
}
