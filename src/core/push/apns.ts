import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { connect } from "node:http2";
import type { ApnsEnvironment } from "./devices.ts";

/**
 * APNsへの送信（トークン認証。HTTP/2 + ES256のJWT）。実行時依存を増やさないため、
 * `node:http2` と `node:crypto` だけで組んでいる。
 *
 * 認証キー（`.p8`）・Key ID・Team ID・Bundle ID は環境変数で受け取る（1Password管理。リポジトリには含めない）。
 * `AIDE_APNS_KEY` は改行を `\n` の2文字で書いた1行でも受け付ける（`.env` やdeployの受け渡しで
 * 複数行が扱いにくいため）。
 */

export interface ApnsConfig {
  key: string;
  keyId: string;
  teamId: string;
  bundleId: string;
}

const DEFAULT_BUNDLE_ID = "com.gucchii.AIDEios";

export function loadApnsConfig(env: NodeJS.ProcessEnv = process.env): ApnsConfig | null {
  const key = (env["AIDE_APNS_KEY"] ?? "").replace(/\\n/g, "\n").trim();
  const keyId = (env["AIDE_APNS_KEY_ID"] ?? "").trim();
  const teamId = (env["AIDE_APNS_TEAM_ID"] ?? "").trim();
  if (!key || !keyId || !teamId) return null;
  return { key, keyId, teamId, bundleId: (env["AIDE_APNS_BUNDLE_ID"] ?? "").trim() || DEFAULT_BUNDLE_ID };
}

export function apnsHost(environment: ApnsEnvironment): string {
  return environment === "production" ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com";
}

function b64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

/** APNsの `iss`(Team ID)・`iat` のJWT。ES256の署名はDERではなくr||s（ieee-p1363）で付ける。 */
export function createApnsJwt(config: Pick<ApnsConfig, "keyId" | "teamId">, privateKey: KeyObject, nowSec: number): string {
  const header = b64url(JSON.stringify({ alg: "ES256", kid: config.keyId }));
  const claims = b64url(JSON.stringify({ iss: config.teamId, iat: nowSec }));
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${header}.${claims}.${b64url(signature)}`;
}

/** APNsは同じトークンを20分〜1時間の間で使い回すことを求める（頻繁な再生成は429）。 */
const JWT_TTL_SEC = 50 * 60;
let cachedJwt: { jwt: string; issuedAt: number; keyId: string } | null = null;

function jwtFor(config: ApnsConfig, nowSec: number): string {
  if (cachedJwt && cachedJwt.keyId === config.keyId && nowSec - cachedJwt.issuedAt < JWT_TTL_SEC) return cachedJwt.jwt;
  const jwt = createApnsJwt(config, createPrivateKey(config.key), nowSec);
  cachedJwt = { jwt, issuedAt: nowSec, keyId: config.keyId };
  return jwt;
}

export interface ApnsResult {
  status: number;
  /** APNsのエラー理由（例: `BadDeviceToken` `Unregistered`）。成功時は null。 */
  reason: string | null;
}

/** 送信の実体。テストでは差し替える。 */
export type ApnsTransport = (
  environment: ApnsEnvironment,
  deviceToken: string,
  headers: Record<string, string>,
  body: string,
) => Promise<ApnsResult>;

const REQUEST_TIMEOUT_MS = 10_000;

export const http2Transport: ApnsTransport = (environment, deviceToken, headers, body) =>
  new Promise((resolve, reject) => {
    const session = connect(apnsHost(environment));
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      session.close();
      fn();
    };
    session.on("error", (cause) => finish(() => reject(cause)));
    const req = session.request({ ":method": "POST", ":path": `/3/device/${deviceToken}`, ...headers });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.close();
      finish(() => reject(new Error("APNs timeout")));
    });
    let status = 0;
    const chunks: Buffer[] = [];
    req.on("response", (h) => {
      status = Number(h[":status"] ?? 0);
    });
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("error", (cause) => finish(() => reject(cause)));
    req.on("end", () => {
      let reason: string | null = null;
      if (status !== 200) {
        try {
          reason = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { reason?: string }).reason ?? null;
        } catch {
          reason = null;
        }
      }
      finish(() => resolve({ status, reason }));
    });
    req.end(body);
  });

export async function sendToApns(
  config: ApnsConfig,
  environment: ApnsEnvironment,
  deviceToken: string,
  payload: unknown,
  transport: ApnsTransport = http2Transport,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<ApnsResult> {
  return transport(
    environment,
    deviceToken,
    {
      authorization: `bearer ${jwtFor(config, nowSec)}`,
      "apns-topic": config.bundleId,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
    },
    JSON.stringify(payload),
  );
}

/** このトークンはもう送れない、とAPNsが判断したもの（登録簿から消してよい）。 */
export function isDeadToken(result: ApnsResult): boolean {
  return result.status === 410 || (result.status === 400 && result.reason === "BadDeviceToken");
}
