import type { IncomingMessage, ServerResponse } from "node:http";
import { clientKey, FAILURE_DELAY_MS, lockedFor, recordFailure, recordSuccess } from "../auth/ratelimit.ts";
import { locationStore, type LocationStore } from "../core/location/store.ts";
import { LIMITS } from "../core/location/types.ts";
import { parseLocation } from "../core/location/validate.ts";
import { bearerToken } from "./secret.ts";

/**
 * 位置共有のAPI（#715）。契約・保存期間・停止手順は README「位置共有」。
 *
 * - `POST /api/location` — iOSアプリが測位を送る。**端末トークン**（`aloc_...`）だけで認証する。
 *   MCPのOAuthトークン・既存の共有シークレットとは別物で、書き込めるのはこの1件の位置だけ
 * - `POST /api/location/enable` — 画面ログインのセッションで共有を有効にし、端末トークンを1回だけ返す
 * - `POST /api/location/disable` — 画面ログインのセッション**または**端末トークンで止める。
 *   トークン失効と保存位置の削除を同時に行う
 *
 * **座標・トークンをログ・例外へ出さない。** 失敗の記録は固定の文言だけ。
 */

export interface LocationApiDeps {
  store?: LocationStore;
  now?: () => Date;
  /** 画面ログインのセッションを持つか。 */
  hasSession: (req: IncomingMessage) => Promise<boolean>;
}

const RATE_WINDOW_MS = 60_000;
const rate = new Map<string, number[]>();

/** 端末ごとの受信回数。上限を超えたら true を返す（記録もここで行う）。 */
export function overRate(deviceId: string, now: number): boolean {
  const recent = (rate.get(deviceId) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
  if (recent.length >= LIMITS.perMinute) {
    rate.set(deviceId, recent);
    return true;
  }
  recent.push(now);
  rate.set(deviceId, recent);
  return false;
}

export function resetLocationRateForTest(): void {
  rate.clear();
}

function json(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res
    .writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra })
    .end(JSON.stringify(body));
}

class BodyTooLarge extends Error {}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > LIMITS.bodyBytes) throw new BodyTooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > LIMITS.bodyBytes) throw new BodyTooLarge();
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as unknown) : {};
}

function isJson(req: IncomingMessage): boolean {
  return String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json");
}

/** Cookie認証のPOSTは、JSON以外（他サイトのフォーム送信）を受けない。 */
function rejectNonJson(req: IncomingMessage, res: ServerResponse): boolean {
  if (isJson(req)) return false;
  json(res, 415, { error: "Content-Type は application/json にしてください" });
  return true;
}

export async function handleLocation(req: IncomingMessage, res: ServerResponse, deps: LocationApiDeps): Promise<void> {
  const store = deps.store ?? locationStore();
  const now = deps.now ?? (() => new Date());
  const path = new URL(req.url ?? "/", "http://localhost").pathname;

  if (req.method !== "POST") {
    json(res, 405, { error: "method not allowed" }, { Allow: "POST" });
    return;
  }

  try {
    if (path === "/api/location/enable") {
      if (rejectNonJson(req, res)) return;
      req.resume();
      if (!(await deps.hasSession(req))) {
        json(res, 401, { error: "unauthorized" });
        return;
      }
      const issued = await store.enable(now());
      json(res, 200, {
        ok: true,
        deviceId: issued.deviceId,
        token: issued.token,
        note: "token はこの応答でだけ返します。端末のKeychainへ保存してください。以前のトークンと保存位置は破棄しました",
      });
      return;
    }

    // ここから先は端末トークンを持つ側（disable は画面のセッションでも可）。
    const key = `loc:${clientKey(req)}`;
    const locked = lockedFor(key);
    if (locked !== null) {
      json(res, 429, { error: "too many attempts" }, { "Retry-After": String(locked) });
      return;
    }

    if (path === "/api/location/disable") {
      if (rejectNonJson(req, res)) return;
      req.resume();
      const token = bearerToken(req);
      const authorized = token ? (await store.authenticate(token)) !== null : await deps.hasSession(req);
      if (!authorized) {
        recordFailure(key);
        json(res, 401, { error: "unauthorized" });
        return;
      }
      recordSuccess(key);
      const { wasEnabled } = await store.disable();
      json(res, 200, { ok: true, wasEnabled, note: "トークンを失効し、保存済みの位置を削除しました" });
      return;
    }

    if (path !== "/api/location") {
      json(res, 404, { error: "not found" });
      return;
    }

    const token = bearerToken(req);
    const deviceId = token ? await store.authenticate(token) : null;
    if (!deviceId) {
      recordFailure(key);
      // 総当たりの試行間隔を空ける。
      await new Promise((r) => setTimeout(r, FAILURE_DELAY_MS));
      console.warn("[location] 認証失敗: POST /api/location");
      json(res, 401, { error: "unauthorized" });
      return;
    }
    recordSuccess(key);
    if (overRate(deviceId, now().getTime())) {
      json(res, 429, { error: "rate limited" }, { "Retry-After": "60" });
      return;
    }
    if (!isJson(req)) {
      json(res, 415, { error: "Content-Type は application/json にしてください" });
      return;
    }

    let body: unknown;
    try {
      body = await readJson(req);
    } catch (cause) {
      if (cause instanceof BodyTooLarge) {
        json(res, 413, { error: `本文が大きすぎます（上限 ${LIMITS.bodyBytes} バイト）` }, { Connection: "close" });
      } else {
        json(res, 400, { error: "本文をJSONとして読めません" });
      }
      return;
    }
    const parsed = parseLocation(body, now());
    if (!parsed.ok) {
      json(res, 400, { error: "invalid", reason: parsed.reason });
      return;
    }
    const outcome = await store.submit(parsed.input, now());
    // 古い・重複は失敗ではなく無視（オフライン後の再送で端末側が詰まらないよう200で返す）。
    json(res, 200, outcome);
  } catch {
    // 例外の中身（座標・トークンを含みうる）は記録しない。
    console.error("[location] 処理に失敗");
    if (!res.headersSent) json(res, 503, { error: "storage_error" });
  }
}
