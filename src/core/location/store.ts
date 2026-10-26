import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DATA_DIR } from "../paths.ts";
import {
  FRESH_MS,
  RETENTION_MS,
  type CurrentLocation,
  type LocationFile,
  type LocationInput,
  type SubmitOutcome,
} from "./types.ts";

/**
 * 位置の保存（#715）。**最新の1件だけ**を `data/location.json`（0600）へ置く。履歴は持たない。
 *
 * - 端末トークンはSHA-256だけを保存し、平文は発行時の応答に1回だけ出す
 * - 古い測位・同じ測位の再送は適用しない（到着順ではなく測位時刻で新旧を決める）
 * - 保存期間（`RETENTION_MS`）を過ぎた位置は読み出し時に削除する
 * - 壊れたファイルは上書きせず例外にする（空として扱って共有を黙って止めない）
 * - 例外・ログに座標とトークンを含めない
 */

export const LOCATION_PATH = process.env["AIDE_LOCATION_PATH"]
  ? resolve(process.env["AIDE_LOCATION_PATH"])
  : resolve(DATA_DIR, "location.json");

const EMPTY: LocationFile = { device: null, location: null };

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export interface LocationStore {
  /** 共有を有効にして端末トークンを発行する。以前のトークンと保存位置は失効・削除する。 */
  enable(now?: Date): Promise<{ token: string; deviceId: string }>;
  /** 共有を止める。トークン失効と保存位置の削除を一度に行う。 */
  disable(): Promise<{ wasEnabled: boolean }>;
  /** 端末トークンを照合する。合えば deviceId、違えば null。 */
  authenticate(token: string): Promise<string | null>;
  submit(input: LocationInput, now?: Date): Promise<SubmitOutcome>;
  current(now?: Date): Promise<CurrentLocation>;
}

export function createLocationStore(path: string = LOCATION_PATH): LocationStore {
  let queue: Promise<unknown> = Promise.resolve();
  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }

  async function read(): Promise<LocationFile> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY };
      throw new Error("位置の保存ファイルを読めません");
    }
    try {
      const parsed = JSON.parse(raw) as LocationFile;
      if (typeof parsed !== "object" || parsed === null || !("device" in parsed) || !("location" in parsed)) throw new Error();
      return parsed;
    } catch {
      throw new Error("位置の保存ファイルが壊れています。上書きせず停止します");
    }
  }

  async function write(data: LocationFile): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  }

  return {
    enable: (now = new Date()) =>
      serialize(async () => {
        const token = `aloc_${randomBytes(32).toString("base64url")}`;
        const deviceId = randomBytes(8).toString("hex");
        await write({
          device: { deviceId, tokenHash: sha256(token).toString("hex"), enabledAt: now.toISOString() },
          location: null,
        });
        return { token, deviceId };
      }),

    disable: () =>
      serialize(async () => {
        const data = await read();
        const wasEnabled = data.device !== null;
        // 座標を残さないため、中身を空にするのではなくファイルごと消す。
        try {
          await unlink(path);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("位置の保存ファイルを削除できません");
        }
        return { wasEnabled };
      }),

    authenticate: (token) =>
      serialize(async () => {
        const { device } = await read();
        if (!device || !token) return null;
        const a = sha256(token);
        const b = Buffer.from(device.tokenHash, "hex");
        return a.length === b.length && timingSafeEqual(a, b) ? device.deviceId : null;
      }),

    submit: (input, now = new Date()) =>
      serialize(async () => {
        const data = await read();
        if (!data.device) throw new Error("位置共有が有効ではありません");
        const stored = data.location;
        if (stored) {
          const storedAt = Date.parse(stored.measuredAt);
          const at = Date.parse(input.measuredAt);
          if (at === storedAt) return { ok: true, applied: false, reason: "duplicate" } as const;
          if (at < storedAt) return { ok: true, applied: false, reason: "older" } as const;
        }
        await write({ ...data, location: { ...input, receivedAt: now.toISOString() } });
        return { ok: true, applied: true } as const;
      }),

    current: (now = new Date()) =>
      serialize(async (): Promise<CurrentLocation> => {
        const data = await read();
        if (!data.device) return { status: "unavailable", reason: "not_enabled" };
        if (!data.location) return { status: "unavailable", reason: "no_location" };
        const age = now.getTime() - Date.parse(data.location.measuredAt);
        if (age > RETENTION_MS) {
          await write({ ...data, location: null });
          return { status: "unavailable", reason: "expired" };
        }
        return {
          status: age <= FRESH_MS ? "fresh" : "stale",
          location: data.location,
          ageSeconds: Math.max(0, Math.floor(age / 1000)),
        };
      }),
  };
}

let shared: LocationStore | undefined;
export function locationStore(): LocationStore {
  return (shared ??= createLocationStore());
}
