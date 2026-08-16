import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/**
 * `/api` 配下の共有シークレット認証。
 *
 * MCPのOAuthとは別系統。呼び出し元が自分の worker と自作アプリに限られるためOAuthは過剰で、
 * 共有シークレット1本で足りる。書き込み（`src/api/ingest.ts`）と読み取り（`src/api/read.ts`）で
 * **別々のシークレット**を使うが、照合の作法は共通なのでここに置く。
 */

/** `Authorization: Bearer xxx` の値。無ければ空文字。 */
export function bearerToken(req: IncomingMessage): string {
  const header = String(req.headers["authorization"] ?? "");
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

/**
 * 定数時間で比較する。
 *
 * 単純な `===` は不一致の位置で早期に返るため、応答時間の差から1文字ずつ絞り込める。
 * 長さが違う場合も、比較そのものを省くと「長さが違う」ことが時間差で漏れるため、
 * ダミーの比較を挟んでから false を返す。
 */
export function secretMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}
