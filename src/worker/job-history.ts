import { readCache, writeCache } from "../core/cache/store.ts";

/**
 * ジョブの実行記録の履歴（直近 `MAX_RUNS` 件）。
 *
 * 最新1件は従来どおり `job-<name>` に上書きで残し（`lastRun` と判定の元）、履歴は
 * `job-<name>-history` に持つ。履歴を足すのは**記録を受け取った側**（受け口・ローカル書き込み）
 * で、worker は1件を送るだけにしてある。worker が現在値を読んで足すには受け口に読み取り口が
 * 要るが、受け取る側なら手元のキャッシュを読むだけで済む（#441）。
 *
 * 履歴のキーは受け口の許可キー（`src/api/ingest.ts`）に入れない。サーバー内部だけで書く。
 */

/** 実行記録のキャッシュキーの接頭辞。`[a-z0-9][a-z0-9-]*` の制約に収まる形にしてある。 */
export const JOB_KEY_PREFIX = "job-";

const HISTORY_SUFFIX = "-history";

/** 残す件数。古いものから捨てる。 */
export const MAX_RUNS = 30;

export interface JobRun {
  ok: boolean;
  /** 記録が書かれた時刻（＝実行の終了時刻）。 */
  at: string;
  seconds: number;
  message: string;
  host: string;
}

export interface JobHistory {
  /** 新しい順。 */
  runs: JobRun[];
}

export function jobHistoryKey(recordKey: string): string {
  return `${recordKey}${HISTORY_SUFFIX}`;
}

function isRecordKey(key: string): boolean {
  return key.startsWith(JOB_KEY_PREFIX) && !key.endsWith(HISTORY_SUFFIX);
}

/** キーごとの直列化。読んで足して書き戻す間に別の記録が割り込むと1件失われる。 */
const queues = new Map<string, Promise<unknown>>();

function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  const tail = next.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return next;
}

function toRun(data: unknown, at: string): JobRun | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  if (typeof record["ok"] !== "boolean") return null;
  return {
    ok: record["ok"],
    at,
    seconds: typeof record["seconds"] === "number" ? record["seconds"] : 0,
    message: typeof record["message"] === "string" ? record["message"] : "",
    host: typeof record["host"] === "string" ? record["host"] : "",
  };
}

/** 履歴を読む。無い・壊れているときは空。 */
export async function readJobRuns(recordKey: string): Promise<JobRun[]> {
  try {
    const cached = await readCache<JobHistory>(jobHistoryKey(recordKey));
    return Array.isArray(cached?.data.runs) ? cached.data.runs.slice(0, MAX_RUNS) : [];
  } catch {
    return [];
  }
}

/**
 * キャッシュへ書く。実行記録のキーなら、最新1件の上書きに加えて履歴へも足す。
 * 履歴の追記に失敗しても最新1件の書き込みは成功させる（判定の元を守る）。
 */
export async function writeCacheWithHistory(
  key: string,
  source: string,
  data: unknown,
): Promise<void> {
  if (!isRecordKey(key)) return writeCache(key, source, data);

  // 最新1件の書き込みも同じ直列化に載せる。`writeCache` の一時ファイル名はプロセス単位のため、
  // 同じキーへの同時書き込みは互いの一時ファイルを奪い合う。
  await serialized(key, () => writeCache(key, source, data));

  const run = toRun(data, new Date().toISOString());
  if (!run) return;
  try {
    await serialized(key, async () => {
      const runs = [run, ...(await readJobRuns(key))].slice(0, MAX_RUNS);
      await writeCache<JobHistory>(jobHistoryKey(key), source, { runs });
    });
  } catch (cause) {
    console.error(
      `[job-history] 履歴を残せませんでした（${key}）: ${cause instanceof Error ? cause.message : cause}`,
    );
  }
}
