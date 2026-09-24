import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthConfig } from "../auth/config.ts";
import { findMobileToken, issueMobileToken, revokeMobileToken } from "../auth/mobile-token.ts";
import { isAllowedEmail, type SupabaseAuthConfig } from "../auth/supabase.ts";
import { buildRoomStatus, type RoomSensorSummary, type RoomStatus } from "../core/views/room.ts";
import { consumeAppHandoff } from "../web/app-auth.ts";
import { bearerToken } from "./secret.ts";

/**
 * iOSアプリなどネイティブクライアント向けのAPI（aide#454。起点 guchi-apps/aide-ios#1）。
 *
 * - `POST /api/mobile/token` ログイン引き継ぎコードをモバイル専用トークンへ交換する
 * - `DELETE /api/mobile/token` アプリ自身が自分のトークンを失効させる
 * - `GET /api/mobile/room-temperature` 「室温」を1件だけ返す（読み取り専用）
 *
 * **操作系は置かない。** トークンは `/api/mobile/*` の読み取りにしか通らない
 * （`src/auth/mobile-token.ts`）。myroomへ繋ぐのは従来どおりAIDEだけで、アプリは直接繋がない。
 */

export interface MobileApiOptions {
  authConfig: AuthConfig;
  /** Googleログインの設定。無い環境ではトークンを発行できない（`null` なら発行口は404）。 */
  supabase: SupabaseAuthConfig | null;
}

const MAX_FORM_BYTES = 4096;

function json(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  res
    .writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    })
    .end(JSON.stringify(payload));
}

function methodNotAllowed(res: ServerResponse, allow: string): void {
  json(res, 405, { error: "method not allowed" }, { Allow: allow });
}

function unauthorized(res: ServerResponse): void {
  json(res, 401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_FORM_BYTES) throw new Error("too large");
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Bearerトークンを検証する。通らなければ401を返して false。
 * **許可リストは使うたびに照合する**（外したアドレスのトークンが有効期間ぶん残らないように）。
 * 認証が無効な環境（`AIDE_AUTH_DISABLED=1`）は他のAPIと同じく素通しにする。
 */
async function authorize(req: IncomingMessage, res: ServerResponse, options: MobileApiOptions): Promise<boolean> {
  if (!options.authConfig.enabled) return true;

  const record = await findMobileToken(bearerToken(req));
  if (!record || (options.supabase && !isAllowedEmail(record.email, options.supabase))) {
    console.warn("[mobile-api] 認証失敗");
    unauthorized(res);
    return false;
  }
  return true;
}

/**
 * `POST /api/mobile/token`（form: `code`・`code_verifier`）と `DELETE /api/mobile/token`。
 *
 * `code` は `/status/auth/app/start?scope=mobile` のGoogleログインで受け取った一回限りのコード。
 * 交換できるのはPKCEのverifierを持つアプリだけで、Web用に発行したコードは使えない。
 */
export async function handleMobileToken(
  req: IncomingMessage,
  res: ServerResponse,
  options: MobileApiOptions,
): Promise<void> {
  if (req.method === "DELETE") {
    const token = bearerToken(req);
    // 存在しない・期限切れでも同じ204にする（トークンの有無を探る材料にしない）。
    if (!token) {
      unauthorized(res);
      return;
    }
    await revokeMobileToken(token);
    res.writeHead(204, { "Cache-Control": "no-store" }).end();
    return;
  }
  if (req.method !== "POST") {
    methodNotAllowed(res, "POST, DELETE");
    return;
  }

  const config = options.supabase;
  if (!config) {
    json(res, 404, { error: "not found" });
    return;
  }

  let form: URLSearchParams;
  try {
    form = await readForm(req);
  } catch {
    json(res, 400, { error: "invalid request" });
    return;
  }

  const handoff = consumeAppHandoff(form.get("code") ?? "", form.get("code_verifier") ?? "", "mobile");
  if (!handoff || !isAllowedEmail(handoff.email, config)) {
    console.warn("[mobile-api] トークン交換に失敗");
    json(res, 401, { error: "login_failed" });
    return;
  }

  const { token, expiresAt } = await issueMobileToken(handoff.email);
  console.log(`[mobile-api] トークンを発行: ${handoff.email}`);
  json(res, 200, { token, tokenType: "Bearer", expiresAt: new Date(expiresAt).toISOString() });
}

export interface RoomTemperature {
  sensorName: string;
  /** 摂氏。 */
  temperature: number;
  /** 測定時刻（ISO8601）。 */
  measuredAt: string | null;
  /** true のときは受信が止まっており、現在値ではない。 */
  stale: boolean;
}

/**
 * どのセンサーを「室温」とするか。**純粋関数。**
 *
 * `preferred`（`AIDE_MOBILE_ROOM_SENSOR`。名前かdeviceId）があればそのセンサーだけを見る。
 * 無いときは「受信が止まっておらず温度のある最初のセンサー」、無ければ温度のある最初のセンサー
 * （`stale: true` で返り、現在値ではないことが伝わる）。**指定したセンサーが見つからないときは
 * 別のセンサーで代えず null にする**（別の部屋の温度を黙って答えないため）。
 */
export function pickRoomTemperature(
  sensors: RoomSensorSummary[],
  preferred: string | null,
): RoomTemperature | null {
  const withTemperature = sensors.filter((s) => s.temperature !== null);
  const chosen = preferred
    ? withTemperature.find((s) => s.name === preferred || String(s.deviceId) === preferred)
    : (withTemperature.find((s) => !s.stale) ?? withTemperature[0]);
  if (!chosen || chosen.temperature === null) return null;
  return {
    sensorName: chosen.name,
    temperature: chosen.temperature,
    measuredAt: chosen.measuredAt,
    stale: chosen.stale,
  };
}

/**
 * `GET /api/mobile/room-temperature`
 *
 * 200 `{sensorName, temperature, measuredAt, stale}` / 401 認証失敗 /
 * 503 myroom未設定・取得失敗 / 502 室温にできるセンサーが無い。
 * **キャッシュしない**（鮮度が価値。`buildRoomStatus()` が呼ぶたびに取得する）。
 */
export async function handleMobileRoomTemperature(
  req: IncomingMessage,
  res: ServerResponse,
  options: MobileApiOptions,
  load: () => Promise<RoomStatus> = buildRoomStatus,
): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    methodNotAllowed(res, "GET, HEAD");
    return;
  }
  if (!(await authorize(req, res, options))) return;

  const status = await load();
  if (!status.configured || !status.complete) {
    json(res, 503, { error: "room_unavailable" });
    return;
  }

  const picked = pickRoomTemperature(status.sensors, process.env["AIDE_MOBILE_ROOM_SENSOR"] || null);
  if (!picked) {
    json(res, 502, { error: "no_temperature" });
    return;
  }
  json(res, 200, picked);
}
