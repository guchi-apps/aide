import { resolve } from "node:path";
import { createRecordFile } from "../../record-file.ts";
import { DATA_DIR } from "../../paths.ts";

/**
 * 業界ニュース週報メール送信の記録（aide#257）。
 *
 * `src/core/connectors/image-mail/log.ts`（aide#230）と目的は同じ——後から振り返るための履歴で、
 * 二重送信を防ぐための `idempotency.ts` とは分けている。
 *
 * **件名・本文は記録しない。** 記事の見出し・要約を平文ログへ溜めない。件数（`articleCount`）と
 * 本文サイズ（`bodyBytes`。HTML本文のバイト数）だけを残す。
 */

const MAX_ENTRIES = 200;

export const NEWS_MAIL_LOG_PATH = process.env["AIDE_NEWS_MAIL_LOG_PATH"]
  ? resolve(process.env["AIDE_NEWS_MAIL_LOG_PATH"])
  : resolve(DATA_DIR, "news-mail-log.json");

export interface NewsMailLogEntry {
  at: string;
  ok: boolean;
  articleCount: number;
  bodyBytes: number;
  messageId: string | null;
  /** 失敗理由（1行）。成功時は null。 */
  reason: string | null;
  ms: number;
}

const file = createRecordFile<NewsMailLogEntry>(NEWS_MAIL_LOG_PATH, MAX_ENTRIES);

/** 記録する。呼び出し側を失敗させない（例外を投げない）。 */
export async function recordNewsMailLog(entry: Omit<NewsMailLogEntry, "at">, now: Date = new Date()): Promise<void> {
  try {
    await file.update((records) => {
      records.push({ ...entry, at: now.toISOString() });
      return { result: undefined, write: true };
    });
  } catch (cause) {
    console.error(
      `[news-mail] 送信記録を残せませんでした: ${cause instanceof Error ? cause.message : cause}`,
    );
  }
}
