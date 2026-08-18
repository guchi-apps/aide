import { hostname } from "node:os";
import { publish } from "./sink.ts";

/**
 * ジョブの実行結果の記録。
 *
 * 失敗は Signaly へ飛ぶが（`notify.ts`）、**通知は流れて消える**ため、後から
 * 「最後に成功したのはいつか」を知る手段が無かった。動作状況ページ（`/status`）が
 * それに答えられるように、実行のたびに結果を1件だけ残す。
 *
 * 置き場はキャッシュ（`publish()`）。**worker はサブPC、サーバーはVPS**で動くため、
 * ファイルに書いてもサーバーからは見えない。取得結果と同じ経路（`POST /api/cache/:key`）に
 * 載せれば、開発機（両方ローカル）と本番（別マシン）で同じコードのまま届く。
 *
 * ジョブごとに別のキーへ書く。1つのキーにまとめると、書く前に現在値を読む必要があり、
 * 受け口（書き込み専用）に読み取り口を足すことになる。
 *
 * 記録するのは成否・時刻・所要時間・1行のメッセージ・実行ホストだけ。取得した値そのもの
 * （残高など）は入れない。
 */

/** キャッシュキーの接頭辞。`[a-z0-9][a-z0-9-]*` の制約に収まる形にしてある。 */
const KEY_PREFIX = "job-";

export function jobRecordKey(job: string): string {
  return `${KEY_PREFIX}${job}`;
}

export interface JobRecord {
  job: string;
  ok: boolean;
  /** 実行を開始した時刻（ISO8601）。キャッシュの `fetchedAt` は書き込み時刻なので別に持つ。 */
  startedAt: string;
  /** 所要秒数。 */
  seconds: number;
  /** 成功時のひとことか、失敗の理由（1行）。 */
  message: string;
  /** 実行したホスト。サブPCとVPSのどちらで動いたかを後から見分ける。 */
  host: string;
}

/**
 * 実行結果を記録する。**呼び出し側を失敗させない。**
 *
 * 記録できなくてもジョブの成否は変わらないため、例外はログ1行に落とす。
 * ここで投げると、成功したジョブが記録の失敗だけで失敗扱いになる。
 */
export async function recordJobRun(record: Omit<JobRecord, "host">): Promise<void> {
  try {
    await publish(jobRecordKey(record.job), "worker", { ...record, host: hostname() });
  } catch (cause) {
    console.error(
      `[record] 実行記録を残せませんでした: ${cause instanceof Error ? cause.message : cause}`,
    );
  }
}
