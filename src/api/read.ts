import type { IncomingMessage, ServerResponse } from "node:http";
import { buildMoneySummary } from "../core/views/money.ts";
import { bearerToken, secretMatches } from "./secret.ts";

/**
 * 既存の個人アプリ向けの読み取りAPI。
 *
 * AIDEは同じデータを、LLMクライアントへはMCPで、個人アプリへはRESTで出す。
 * ここはその後者にあたる。**キャッシュを読むだけで、取得は行わない**
 * （Zaim巡回は worker の仕事。README「取得と提供の分離」）。
 *
 * 出すのは横断ビュー（`buildMoneySummary()`）で、キャッシュの生の形は出さない。
 * 外へ見せる契約を1本に保ち、キャッシュの構造を後から変えられる余地を残すため。
 *
 * 認証は共有シークレット1本で、**書き込み用の `AIDE_INGEST_SECRET` とは別の値**にする。
 * 同じ値を使うと、読み取りたいだけのアプリへ書き込み権限まで渡すことになる。
 */

export function readSecret(): string | null {
  return process.env["AIDE_READ_SECRET"] || null;
}

/**
 * 認証を通す。通れば true。通らなければ応答を書き終えて false。
 *
 * シークレット未設定は503で、401とは分ける。「設定していないから開いていない」と
 * 「値が違う」を同じ応答にすると、連携時にどちらなのか切り分けられない。
 */
function authorize(req: IncomingMessage, res: ServerResponse, label: string): boolean {
  const expected = readSecret();
  if (!expected) {
    res
      .writeHead(503, { "Content-Type": "application/json; charset=utf-8" })
      .end(JSON.stringify({ error: "AIDE_READ_SECRET が未設定のため利用できません" }));
    return false;
  }

  const presented = bearerToken(req);
  if (!presented || !secretMatches(presented, expected)) {
    console.warn(`[read] 認証失敗: ${label}`);
    res
      .writeHead(401, { "Content-Type": "application/json; charset=utf-8" })
      .end(JSON.stringify({ error: "unauthorized" }));
    return false;
  }
  return true;
}

/**
 * `GET /api/money/summary`
 *
 * MCPツール `aide_money_summary` と同じ内容を返す。呼び出し側（asset-manager）が要る
 * `balances`・`holdings` に加えて、`fetchedAt`・`ageMinutes`・`stale` を必ず併せて返す。
 * **鮮度の判断は呼び出し側に委ねる**（`src/core/views/money.ts` と同じ方針）。
 */
export async function handleMoneySummary(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // 認証の前にメソッドを見る。未対応のメソッドに401を返すと、
  // 呼び出し側が「鍵が違うのか叩き方が違うのか」を切り分けられない。
  if (req.method !== "GET" && req.method !== "HEAD") {
    res
      .writeHead(405, { "Content-Type": "application/json; charset=utf-8", Allow: "GET, HEAD" })
      .end(JSON.stringify({ error: "method not allowed" }));
    return;
  }

  if (!authorize(req, res, "GET /api/money/summary")) return;

  // キャッシュが空でも200を返す。「まだ一度も取得していない」は状態であってエラーではなく、
  // empty / fetchedAt を見れば呼び出し側で区別できる（MCP側が isError:false にしているのと同じ理由）。
  const summary = await buildMoneySummary();
  res
    .writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      // 残高は変わるうえ、値そのものが個人情報にあたる。中間に残させない。
      "Cache-Control": "no-store",
    })
    .end(JSON.stringify(summary));
}
