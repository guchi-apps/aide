import type { IncomingMessage, ServerResponse } from "node:http";
import { writeCache } from "../core/cache/store.ts";
import { JOB_CATALOG } from "../worker/jobs/catalog.ts";
import { CLAUDE_SESSIONS_CACHE_KEY } from "../worker/jobs/claude-sessions-sync.ts";
import { WEATHER_CACHE_KEY } from "../worker/jobs/weather-sync.ts";
import { jobRecordKey } from "../worker/record.ts";
import { bearerToken, secretMatches } from "./secret.ts";

/**
 * worker からの取得結果の受け口。
 *
 * worker（重いPlaywright巡回）は常時起動のサブPCで動き、MCPサーバーはVPSで動く。
 * 別マシンなのでキャッシュファイルを共有できないため、workerがHTTPで送る。
 *
 * 認証は共有シークレット1本。呼び出し元が自分のworkerに限られるので、
 * OAuthを通すのは過剰。issue-deck の dispatch と同じ方式に揃えている。
 */

const MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * キーは参照側と揃える必要があるため、受け入れるものを明示的に限定する。
 *
 * 巡回結果（`zaim-snapshot`）・天気予報（`weather-forecast`）だけでなく、
 * **ジョブの実行記録（`job-<ジョブ名>`）も受け入れる。**
 * 記録は worker（サブPC）が巡回結果と同じ経路で送るため、ここで弾くと本番では届かず、
 * 動作状況ページ（`/status`）のジョブ欄が永久に「記録なし」のままになる（#89）。
 * 記録側は失敗しても例外を投げない作りなので、404で弾いてもログ1行しか残らず気づけない。
 *
 * **データのキーは定義元から import する。** リテラルで再掲すると、ジョブを追加したときに
 * ここへの追加が漏れ、送信のたびに404になる（天気予報で実際に起きた。#108）。
 * 例外は巡回結果（`zaim-snapshot`）で、`worker/jobs/zaim-sync.ts` を import すると
 * Playwright を使う巡回本体まで読み込むため、受け口ではリテラルのまま持つ。
 * 実行記録のキーはカタログから作り、ジョブを増やしたときの取りこぼしを防ぐ。
 */
const ALLOWED_KEYS = new Set<string>([
  "zaim-snapshot",
  WEATHER_CACHE_KEY,
  CLAUDE_SESSIONS_CACHE_KEY,
  ...JOB_CATALOG.map((job) => jobRecordKey(job.name)),
]);

export function ingestSecret(): string | null {
  return process.env["AIDE_INGEST_SECRET"] || null;
}

export async function handleIngest(
  req: IncomingMessage,
  res: ServerResponse,
  key: string,
): Promise<void> {
  const expected = ingestSecret();
  if (!expected) {
    res.writeHead(503, { "Content-Type": "application/json" })
      .end(JSON.stringify({ error: "AIDE_INGEST_SECRET が未設定のため受け付けられません" }));
    return;
  }

  const presented = bearerToken(req);
  if (!presented || !secretMatches(presented, expected)) {
    console.warn(`[ingest] 認証失敗: key=${key}`);
    res.writeHead(401, { "Content-Type": "application/json" })
      .end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  if (!ALLOWED_KEYS.has(key)) {
    res.writeHead(404, { "Content-Type": "application/json" })
      .end(JSON.stringify({ error: `未知のキー: ${key}` }));
    return;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // 巡回結果は数KB程度。想定を大きく超えるものは読み切らずに切る。
    if (size > MAX_BODY_BYTES) {
      res.writeHead(413, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: "payload too large" }));
      return;
    }
    chunks.push(chunk as Buffer);
  }

  let payload: { source?: string; data?: unknown };
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" })
      .end(JSON.stringify({ error: "invalid json" }));
    return;
  }
  if (payload.data === undefined) {
    res.writeHead(400, { "Content-Type": "application/json" })
      .end(JSON.stringify({ error: "data が必要です" }));
    return;
  }

  await writeCache(key, payload.source ?? "worker", payload.data);
  console.log(`[ingest] 受信: key=${key} source=${payload.source ?? "worker"}`);
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
}
