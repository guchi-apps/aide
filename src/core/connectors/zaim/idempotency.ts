import { resolve } from "node:path";
import { DATA_DIR } from "../../paths.ts";
import { createRecordFile } from "../../record-file.ts";

/**
 * 登録済みかどうかの記録。**同じ支出を二重にZaimへ登録しないためだけに持つ。**
 *
 * 呼び出し元（car-care・asset-manager）は `requestId` を自分のレコードから一意に決めて送る
 * （例: `car-care:fuel-log:1234`）。応答が届かずに再送されても、ここに記録があれば
 * Zaimへは送らず、前回の `money_id` をそのまま返す。
 *
 * **中身は `requestId`・`moneyId`・時刻の3つだけ。** 金額・店名・コメントは書かない。
 * 二重登録を防ぐのに要らないうえ、支出の中身そのものを持つとAIDEの責務（取得・整形）から外れる。
 *
 * 置き場はJSONファイル。キャッシュ（`src/core/cache/store.ts`）とは別で、こちらは
 * 消えると二重登録が起きるため「キャッシュ」ではなく記録として扱う。
 * Zaimのログイン状態（`data/zaim/storage-state.json`）とも別のファイルにしている。
 */

/** 保持する件数。呼び出し元は登録後に自分で `money_id` を保存するため、AIDE側は再送の窓だけ持てばよい。 */
const MAX_RECORDS = 500;

/** テストが本番の記録を汚さないよう差し替えられるようにしている（`AIDE_CACHE_DIR` と同じ考え方）。 */
export const PAYMENT_LOG_PATH = process.env["AIDE_ZAIM_PAYMENT_LOG_PATH"]
  ? resolve(process.env["AIDE_ZAIM_PAYMENT_LOG_PATH"])
  : resolve(DATA_DIR, "zaim-payments.json");

export interface PaymentRecord {
  requestId: string;
  /**
   * Zaim側のレコードID。**null は「送ったが結果が確定していない」。**
   * 打ち切り・通信断のときにこの状態で残り、再送を機械的に止めるための印になる。
   */
  moneyId: number | null;
  /** 記録した時刻（ISO8601）。 */
  at: string;
}

export type BeginResult =
  /** 未登録。Zaimへ送ってよい。 */
  | { status: "new" }
  /** 登録済み。Zaimへは送らず、この `moneyId` を返す。 */
  | { status: "done"; moneyId: number }
  /** 前回の結果が不明。**勝手に再送しない**（二重登録になりうるため人が確認する）。 */
  | { status: "unresolved"; at: string };

/** 読み書きの直列化と、壊れない書き出しは `record-file.ts` が持つ（Web版経由の記録と共通）。 */
const file = createRecordFile<PaymentRecord>(PAYMENT_LOG_PATH, MAX_RECORDS);

/**
 * 登録してよいかを判定し、通す場合は「結果不明」の記録を先に置く。
 *
 * **送る前に記録するのが要点。** 送った後に記録すると、打ち切られた場合に何も残らず、
 * 再送で二重登録になる。先に置いておけば、結果が確定しなかったことが次回に伝わる。
 */
export function beginPayment(requestId: string, now: Date = new Date()): Promise<BeginResult> {
  return file.update<BeginResult>((records) => {
    const existing = records.find((record) => record.requestId === requestId);
    if (existing) {
      return {
        result:
          existing.moneyId === null
            ? ({ status: "unresolved", at: existing.at } as const)
            : ({ status: "done", moneyId: existing.moneyId } as const),
        write: false,
      };
    }
    records.push({ requestId, moneyId: null, at: now.toISOString() });
    return { result: { status: "new" } as const, write: true };
  });
}

/** 登録が確定したので `money_id` を書き込む。 */
export function completePayment(requestId: string, moneyId: number, now: Date = new Date()): Promise<void> {
  return file.update((records) => {
    const existing = records.find((record) => record.requestId === requestId);
    if (existing) {
      existing.moneyId = moneyId;
      existing.at = now.toISOString();
    } else {
      records.push({ requestId, moneyId, at: now.toISOString() });
    }
    return { result: undefined, write: true };
  });
}

/**
 * 登録されなかったことが**確実な**場合に記録を消す。
 *
 * Zaimが内容を拒んだ（4xx）ときだけ呼ぶ。打ち切り・5xx では呼ばない——
 * 登録された可能性が残るため、記録を消すと再送で二重登録になる。
 */
export function abandonPayment(requestId: string): Promise<void> {
  return file.update((records) => {
    const remaining = records.filter((record) => record.requestId !== requestId);
    if (remaining.length === records.length) return { result: undefined, write: false };
    records.splice(0, records.length, ...remaining);
    return { result: undefined, write: true };
  });
}

/**
 * 同じ内容から作られた記録をまとめて引く（aide#135）。
 *
 * MCP経由の登録には呼び出し元のレコードが無いため、`requestId` を**支出の内容から**作る
 * （`src/mcp/tools/zaim.ts`）。同じ内容を2回頼まれたときに「前も登録した」と気づくには、
 * 書き込む前に読むだけの口が要る。`beginPayment()` は判定と同時に記録を置いてしまうので使えない。
 *
 * 引くのは `base` そのものと `base#2` 以降。同じ日・同じ店・同じ金額の**正当な2件目**は
 * `base#2` として通すため、系列としてまとめて見えるようにしてある。
 */
export function findPaymentSeries(base: string): Promise<PaymentRecord[]> {
  return file.update((records) => ({
    result: records.filter(
      (record) => record.requestId === base || record.requestId.startsWith(`${base}#`),
    ),
    write: false,
  }));
}

/**
 * 系列の中でまだ使っていない `requestId` を決める。
 *
 * **件数ではなく空き番号で決める。** 古い記録は `MAX_RECORDS` で落ちるため、件数から作ると
 * 残っている番号と衝突し、別の支出のはずが「登録済み」として素通りしてしまう。
 */
export function nextRequestId(base: string, series: readonly PaymentRecord[]): string {
  const used = new Set<number>();
  for (const record of series) {
    if (record.requestId === base) {
      used.add(1);
      continue;
    }
    const suffix = Number(record.requestId.slice(base.length + 1));
    if (Number.isInteger(suffix) && suffix > 0) used.add(suffix);
  }
  let n = 1;
  while (used.has(n)) n += 1;
  return n === 1 ? base : `${base}#${n}`;
}
