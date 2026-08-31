import { resolve } from "node:path";
import { createRecordFile } from "../../record-file.ts";
import { DATA_DIR } from "../../paths.ts";

/**
 * 画像メール送信の記録（aide#230の受け入れ条件「送信成功・失敗、件数、横幅、ZIPサイズ、
 * Gmail messageIdをAIDEの通知・履歴として記録する」）。
 *
 * `idempotency.ts` とは目的が違うので分けている。あちらは「二重送信を防ぐための最小限の
 * 状態」、こちらは「後から振り返るための履歴」。
 *
 * **タイトルは記録しない。** 受け入れ条件が列挙しているのは件数・横幅・ZIPサイズ・
 * messageIdまでで、写真の内容を示唆する文字列（タイトル）を平文ログへ溜めない。
 *
 * 送信頻度が低い（人が写真を送る操作が起点）ため、`src/mcp/access-log.ts` のような
 * まとめ書き（バッファリング）の最適化はせず、1件ごとにそのまま書く。
 */

const MAX_ENTRIES = 200;

export const IMAGE_MAIL_LOG_PATH = process.env["AIDE_IMAGE_MAIL_LOG_PATH"]
  ? resolve(process.env["AIDE_IMAGE_MAIL_LOG_PATH"])
  : resolve(DATA_DIR, "image-mail-log.json");

export interface ImageMailLogEntry {
  at: string;
  ok: boolean;
  imageCount: number;
  width: 1200 | 900 | 600;
  zipBytes: number;
  messageId: string | null;
  /** 失敗理由（1行）。成功時は null。 */
  reason: string | null;
  ms: number;
}

const file = createRecordFile<ImageMailLogEntry>(IMAGE_MAIL_LOG_PATH, MAX_ENTRIES);

/** 記録する。呼び出し側を失敗させない（例外を投げない）。 */
export async function recordImageMailLog(entry: Omit<ImageMailLogEntry, "at">, now: Date = new Date()): Promise<void> {
  try {
    await file.update((records) => {
      records.push({ ...entry, at: now.toISOString() });
      return { result: undefined, write: true };
    });
  } catch (cause) {
    console.error(
      `[image-mail] 送信記録を残せませんでした: ${cause instanceof Error ? cause.message : cause}`,
    );
  }
}
