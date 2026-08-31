import { resolve } from "node:path";
import { DATA_DIR } from "../../paths.ts";
import { createRecordFile } from "../../record-file.ts";

/**
 * Web版の入力画面から登録したかどうかの記録（#214）。
 *
 * 役割は公式API経由の `idempotency.ts` と同じで、**同じ明細を二重にZaimへ登録しない**ため
 * だけに持つ。分けているのは、記録に持てるものが違うから。
 *
 * | | 公式API経由（`idempotency.ts`） | Web版の入力画面経由（ここ） |
 * |---|---|---|
 * | ZaimのレコードID | 応答の `money.id` を持てる | **持てない**（画面にIDが出ない） |
 * | 「確定した」の印 | `moneyId` が入っていること | `state: "done"` |
 * | ファイル | `data/zaim-payments.json` | `data/zaim-web-payments.json` |
 *
 * **1つのファイルに混ぜない。** あちらは「`moneyId` が null ＝ 結果が確定していない」という
 * 読み方をしており、IDを持てないこちらの記録を混ぜると、登録できた明細まで
 * 「結果不明」として扱われる（そして次の再送が永久に止まる）。
 *
 * **中身は `requestId`・状態・時刻の3つだけ。** 金額・店名・品目は書かない。
 * 二重登録を防ぐのに要らないうえ、支出の中身そのものを持つとAIDEの責務から外れる
 * （`idempotency.ts` と同じ方針）。
 */

/** 保持する件数。呼び出し元は登録後に自分の側で済みを持つため、AIDE側は再送の窓だけ持てばよい。 */
const MAX_RECORDS = 500;

/** テストが本番の記録を汚さないよう差し替えられるようにしている。 */
export const WEB_PAYMENT_LOG_PATH = process.env["AIDE_ZAIM_WEB_PAYMENT_LOG_PATH"]
  ? resolve(process.env["AIDE_ZAIM_WEB_PAYMENT_LOG_PATH"])
  : resolve(DATA_DIR, "zaim-web-payments.json");

export interface WebPaymentRecord {
  requestId: string;
  /**
   * - `sending` … 画面を操作し始めたが、登録できたか確かめられていない
   * - `done` … 登録できた
   */
  state: "sending" | "done";
  /** 記録した時刻（ISO8601）。 */
  at: string;
}

export type BeginWebResult =
  /** 未登録。画面を操作してよい。 */
  | { status: "new" }
  /** 登録済み。もう一度登録しない。 */
  | { status: "done"; at: string }
  /** 前回の結果が不明。**勝手にやり直さない**（二重登録になりうるため人がZaimを確認する）。 */
  | { status: "unresolved"; at: string };

const file = createRecordFile<WebPaymentRecord>(WEB_PAYMENT_LOG_PATH, MAX_RECORDS);

/**
 * 登録してよいかを判定し、通す場合は「結果不明」の記録を先に置く。
 *
 * **画面を触る前に記録するのが要点。** 送信の直後に打ち切られた場合、後から記録する作りだと
 * 何も残らず、再送で二重登録になる。先に置いておけば、結果が確定しなかったことが次回に伝わる。
 */
export function beginWebPayment(requestId: string, now: Date = new Date()): Promise<BeginWebResult> {
  return file.update<BeginWebResult>((records) => {
    const existing = records.find((record) => record.requestId === requestId);
    if (existing) {
      return {
        result:
          existing.state === "done"
            ? ({ status: "done", at: existing.at } as const)
            : ({ status: "unresolved", at: existing.at } as const),
        write: false,
      };
    }
    records.push({ requestId, state: "sending", at: now.toISOString() });
    return { result: { status: "new" } as const, write: true };
  });
}

/** 登録できたことが確かめられたので、確定として記録する。 */
export function completeWebPayment(requestId: string, now: Date = new Date()): Promise<void> {
  return file.update((records) => {
    const existing = records.find((record) => record.requestId === requestId);
    if (existing) {
      existing.state = "done";
      existing.at = now.toISOString();
    } else {
      records.push({ requestId, state: "done", at: now.toISOString() });
    }
    return { result: undefined, write: true };
  });
}

/**
 * 登録されなかったことが**確実な**場合に記録を消す。
 *
 * 呼ぶのは、**送信ボタンを押す前に失敗した**と分かっているときだけ（入力欄が見つからない、
 * カテゴリが候補に無い、日付を入れられない など）。送信した後の失敗では呼ばない——
 * 登録された可能性が残るため、記録を消すと再送で二重登録になる。
 */
export function abandonWebPayment(requestId: string): Promise<void> {
  return file.update((records) => {
    const remaining = records.filter((record) => record.requestId !== requestId);
    if (remaining.length === records.length) return { result: undefined, write: false };
    records.splice(0, records.length, ...remaining);
    return { result: undefined, write: true };
  });
}
