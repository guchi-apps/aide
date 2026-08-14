import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { writeCache } from "../core/cache/store.ts";

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

/** キーは参照側と揃える必要があるため、受け入れるものを明示的に限定する。 */
const ALLOWED_KEYS = new Set(["zaim-snapshot"]);

function secretMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

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

  const header = String(req.headers["authorization"] ?? "");
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
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
