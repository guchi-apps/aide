import { resolve } from "node:path";
import { DATA_DIR } from "../../paths.ts";
import { createRecordFile } from "../../record-file.ts";

/**
 * 既存明細のカテゴリ・内訳の変更（#273）を二重に行わないための記録。
 *
 * 役割は新規登録の `web-idempotency.ts` と同じで、**同じ明細への変更を二重に送らない**
 * ためだけに持つ。分けているのは、記録に持てるものが違うから。
 *
 * | | 新規登録（`web-idempotency.ts`） | 既存明細の変更（ここ） |
 * |---|---|---|
 * | ZaimのレコードID | 持てない（画面にIDが出ない） | **呼び出し元が渡す** `moneyId` をそのまま持てる |
 * | 「確定した」の印 | `state: "done"` | 同じく `state: "done"` |
 * | ファイル | `data/zaim-web-payments.json` | `data/zaim-web-genre-edits.json` |
 *
 * `moneyId` を記録に持てるので、確定済みの再送では画面を開かずその `moneyId` をそのまま
 * 返せる（応答の形が `{ moneyId, duplicated, requestId }` で、新規登録と違い `moneyId` が
 * `null` にならない）。
 *
 * **中身は `requestId`・`moneyId`・状態・時刻の4つだけ。** 変更後のカテゴリ・内訳・
 * 金額・日付は書かない。二重実行を防ぐのに要らないうえ、支出の中身そのものを持つと
 * AIDEの責務から外れる（`idempotency.ts` / `web-idempotency.ts` と同じ方針）。
 */

/** 保持する件数。呼び出し元は変更後に自分の側で済みを持つため、AIDE側は再送の窓だけ持てばよい。 */
const MAX_RECORDS = 500;

/** テストが本番の記録を汚さないよう差し替えられるようにしている。 */
export const WEB_GENRE_EDIT_LOG_PATH = process.env["AIDE_ZAIM_WEB_GENRE_EDIT_LOG_PATH"]
  ? resolve(process.env["AIDE_ZAIM_WEB_GENRE_EDIT_LOG_PATH"])
  : resolve(DATA_DIR, "zaim-web-genre-edits.json");

export interface WebGenreEditRecord {
  requestId: string;
  moneyId: number;
  /**
   * - `sending` … 画面を操作し始めたが、変更できたか確かめられていない
   * - `done` … 変更できた
   */
  state: "sending" | "done";
  /** 記録した時刻（ISO8601）。 */
  at: string;
}

export type BeginWebGenreEditResult =
  /** 未変更。画面を操作してよい。 */
  | { status: "new" }
  /** 変更済み。もう一度変更しない。 */
  | { status: "done"; moneyId: number; at: string }
  /** 前回の結果が不明。**勝手にやり直さない**（二重実行になりうるため人がZaimを確認する）。 */
  | { status: "unresolved"; at: string };

const file = createRecordFile<WebGenreEditRecord>(WEB_GENRE_EDIT_LOG_PATH, MAX_RECORDS);

/**
 * 変更してよいかを判定し、通す場合は「結果不明」の記録を先に置く。
 *
 * **画面を触る前に記録するのが要点。** 送信の直後に打ち切られた場合、後から記録する作りだと
 * 何も残らず、再送で二重実行になる。先に置いておけば、結果が確定しなかったことが次回に伝わる。
 */
export function beginWebGenreEdit(
  requestId: string,
  moneyId: number,
  now: Date = new Date(),
): Promise<BeginWebGenreEditResult> {
  return file.update<BeginWebGenreEditResult>((records) => {
    const existing = records.find((record) => record.requestId === requestId);
    if (existing) {
      return {
        result:
          existing.state === "done"
            ? ({ status: "done", moneyId: existing.moneyId, at: existing.at } as const)
            : ({ status: "unresolved", at: existing.at } as const),
        write: false,
      };
    }
    records.push({ requestId, moneyId, state: "sending", at: now.toISOString() });
    return { result: { status: "new" } as const, write: true };
  });
}

/** 変更できたことが確かめられたので、確定として記録する。 */
export function completeWebGenreEdit(
  requestId: string,
  moneyId: number,
  now: Date = new Date(),
): Promise<void> {
  return file.update((records) => {
    const existing = records.find((record) => record.requestId === requestId);
    if (existing) {
      existing.moneyId = moneyId;
      existing.state = "done";
      existing.at = now.toISOString();
    } else {
      records.push({ requestId, moneyId, state: "done", at: now.toISOString() });
    }
    return { result: undefined, write: true };
  });
}

/**
 * 変更されなかったことが**確実な**場合に記録を消す。
 *
 * 呼ぶのは、**送信ボタンを押す前に失敗したと分かっているときだけ**（入力欄が見つからない、
 * カテゴリが候補に無い、開いた明細の日付・金額が一致しない など）。送信した後の失敗では
 * 呼ばない——変更された可能性が残るため、記録を消すと再送で二重実行になる。
 */
export function abandonWebGenreEdit(requestId: string): Promise<void> {
  return file.update((records) => {
    const remaining = records.filter((record) => record.requestId !== requestId);
    if (remaining.length === records.length) return { result: undefined, write: false };
    records.splice(0, records.length, ...remaining);
    return { result: undefined, write: true };
  });
}
