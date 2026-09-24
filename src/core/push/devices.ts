import { join } from "node:path";
import { createRecordFile } from "../record-file.ts";
import { DATA_DIR } from "../paths.ts";

/**
 * APNsのデバイストークンの登録簿（aide#463。起点 guchi-apps/aide-ios#4）。
 *
 * トークンは端末を指す識別子で、これだけでは通知を送れない（送るにはAPNsの認証キーが要る）。
 * それでも他人に見せる理由は無いので、Issueコメントやログへは出さない（ログには先頭8桁だけ）。
 */

const DEVICES_PATH = process.env["AIDE_PUSH_DEVICES_PATH"] || join(DATA_DIR, "push-devices.json");

/** 端末の入れ替えで増えても際限なく溜めない。 */
const MAX_DEVICES = 50;

export type ApnsEnvironment = "development" | "production";

export interface PushDevice {
  /** APNsトークン（hex小文字）。 */
  deviceToken: string;
  environment: ApnsEnvironment;
  /** 通知種別ごとのオン・オフ。キーが無い種別はオン。 */
  preferences: Record<string, boolean>;
  registeredAt: string;
  updatedAt: string;
}

const file = createRecordFile<PushDevice>(DEVICES_PATH, MAX_DEVICES);

/** APNsのトークンはhex。長さは仕様上変わりうるので下限と上限だけ見る。 */
export function normalizeDeviceToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const token = value.trim().toLowerCase();
  return /^[0-9a-f]{32,200}$/.test(token) ? token : null;
}

export function normalizeEnvironment(value: unknown): ApnsEnvironment | null {
  return value === "development" || value === "production" ? value : null;
}

const KIND_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function isValidKind(kind: unknown): kind is string {
  return typeof kind === "string" && KIND_PATTERN.test(kind);
}

/** 不正な種別名・真偽値以外は捨てる。省略（undefined）は「全種別オン」= 空。 */
export function normalizePreferences(value: unknown): Record<string, boolean> | null {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const result: Record<string, boolean> = {};
  for (const [kind, on] of Object.entries(value)) {
    if (!isValidKind(kind) || typeof on !== "boolean") return null;
    result[kind] = on;
  }
  return result;
}

/** 登録する。同じトークンの再登録は更新（`registeredAt` は保つ）。 */
export function upsertDevice(
  input: { deviceToken: string; environment: ApnsEnvironment; preferences: Record<string, boolean> },
  now: Date = new Date(),
): Promise<void> {
  return file.update((records) => {
    const at = now.toISOString();
    const existing = records.find((r) => r.deviceToken === input.deviceToken);
    if (existing) {
      existing.environment = input.environment;
      existing.preferences = input.preferences;
      existing.updatedAt = at;
    } else {
      records.push({ ...input, registeredAt: at, updatedAt: at });
    }
    return { result: undefined, write: true };
  });
}

/** 失効させる。未登録でもエラーにしない。消したときだけ true。 */
export function removeDevice(deviceToken: string): Promise<boolean> {
  return file.update((records) => {
    const index = records.findIndex((r) => r.deviceToken === deviceToken);
    if (index < 0) return { result: false, write: false };
    records.splice(index, 1);
    return { result: true, write: true };
  });
}

export function listDevices(): Promise<PushDevice[]> {
  return file.update((records) => ({ result: records.map((r) => ({ ...r })), write: false }));
}

/** ログ用。トークン全体は出さない。 */
export function shortToken(deviceToken: string): string {
  return `${deviceToken.slice(0, 8)}…`;
}
