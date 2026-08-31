import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * 「登録済みかどうかの記録」を置くJSONファイルの読み書き。
 *
 * 二重登録を防ぐ記録は**経路ごとに別のファイル**へ置く。公式API経由（`idempotency.ts`）は
 * ZaimのレコードID（`money_id`）を持てるが、Web版の入力画面経由（`web-idempotency.ts`）は
 * 画面からIDを読めないため、記録に持てるものが違う。1つのファイルに混ぜると
 * 「IDが無い＝結果が確定していない」という判定が経路をまたいで壊れる。
 *
 * 違うのは記録の形だけで、**壊れない書き方（直列化・一時ファイル経由の差し替え・
 * 壊れていたら空として扱う）は同じ**なので、そこだけをここへ寄せている。
 */

export interface RecordFile<T> {
  /**
   * 記録を読み、渡した関数に触らせ、必要なら書き戻す。
   *
   * **呼び出しは直列化される。** 1プロセスだが、読み込み〜書き出しのあいだに `await` を
   * 挟むため、同時に2件届くと片方の記録が消える。件数が少ないので素直に直列化して済ませる。
   */
  update<R>(task: (records: T[]) => { result: R; write: boolean } | Promise<{ result: R; write: boolean }>): Promise<R>;
}

export function createRecordFile<T>(path: string, maxRecords: number): RecordFile<T> {
  /** 直列化のためのキュー。失敗しても後続を止めない。 */
  let queue: Promise<unknown> = Promise.resolve();

  async function readAll(): Promise<T[]> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw cause;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      // 壊れていたら空として扱う。ここで例外にすると登録そのものが通らなくなる。
      console.warn(`[zaim] 登録記録が読めないため、空として扱います: ${path}`);
      return [];
    }
  }

  async function writeAll(records: T[]): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    // 一時ファイルへ書いてから rename する（キャッシュと同じ理由。書き込み中に読まれても壊れない）。
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(records.slice(-maxRecords), null, 2), "utf8");
    await rename(tmp, path);
  }

  return {
    update(task) {
      const run = async () => {
        const records = await readAll();
        const { result, write } = await task(records);
        if (write) await writeAll(records);
        return result;
      };
      const next = queue.then(run, run);
      queue = next.catch(() => undefined);
      return next;
    },
  };
}
