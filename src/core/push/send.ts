import { loadApnsConfig, isDeadToken, sendToApns, type ApnsConfig, type ApnsTransport } from "./apns.ts";
import { isValidKind, listDevices, removeDevice, shortToken } from "./devices.ts";

/**
 * 登録済みの端末へプッシュ通知を送る（aide#463）。
 *
 * **本文へ金額・個人情報・トークンを入れない。** 文面は種別ごとの固定文だけで、呼び出し側から
 * 任意の文字列は渡せない。詳細はアプリからAIDEの画面（`path`）を開いて確認させる。
 */

/** 種別ごとの固定の本文。未知の種別は既定文。 */
const BODIES: Record<string, string> = {
  test: "テスト通知です",
};
const DEFAULT_BODY = "AIDEに新しいお知らせがあります";

export interface PushPayload {
  aps: { alert: { title: string; body: string }; sound: string };
  kind: string;
  path: string;
}

/** `path` はAIDE内の相対パス。`//host` や `https://` を通すと外部へ誘導できてしまうため弾く。 */
export function isSafePath(path: unknown): path is string {
  return typeof path === "string" && /^\/(?!\/)[^\s\\]*$/.test(path);
}

export function buildPayload(kind: string, path: string): PushPayload {
  if (!isValidKind(kind)) throw new Error("invalid kind");
  if (!isSafePath(path)) throw new Error("invalid path");
  return {
    aps: { alert: { title: "AIDE", body: BODIES[kind] ?? DEFAULT_BODY }, sound: "default" },
    kind,
    path,
  };
}

export interface PushSummary {
  /** APNsの設定が無く、送れなかった。 */
  configured: boolean;
  sent: number;
  failed: number;
  /** 無効と判断して登録簿から消した数。 */
  removed: number;
  /** 種別の設定でオフの端末。 */
  skipped: number;
}

export async function sendPush(
  kind: string,
  path: string,
  deps: { config?: ApnsConfig | null; transport?: ApnsTransport } = {},
): Promise<PushSummary> {
  const payload = buildPayload(kind, path);
  const summary: PushSummary = { configured: true, sent: 0, failed: 0, removed: 0, skipped: 0 };
  const config = deps.config === undefined ? loadApnsConfig() : deps.config;
  if (!config) return { ...summary, configured: false };

  for (const device of await listDevices()) {
    if (device.preferences[kind] === false) {
      summary.skipped++;
      continue;
    }
    try {
      const result = await sendToApns(config, device.environment, device.deviceToken, payload, deps.transport);
      if (result.status === 200) {
        summary.sent++;
      } else if (isDeadToken(result)) {
        await removeDevice(device.deviceToken);
        summary.removed++;
        console.log(`[push] 無効なトークンを削除: ${shortToken(device.deviceToken)} (${result.status} ${result.reason ?? ""})`);
      } else {
        summary.failed++;
        console.warn(`[push] 送信失敗: ${shortToken(device.deviceToken)} (${result.status} ${result.reason ?? ""})`);
      }
    } catch (cause) {
      summary.failed++;
      console.warn(`[push] 送信できません: ${shortToken(device.deviceToken)} (${(cause as Error).message})`);
    }
  }
  return summary;
}
