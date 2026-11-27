import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { TRAVEL_MODES, type TravelMode } from "../connectors/dayspan/travels.ts";
import { DATA_DIR } from "../paths.ts";

/**
 * 自宅プロフィールの正本（#911）。`data/home-profile.json`（0600）へ1件だけ置く。
 *
 * - **初期値は持たない。** ファイルが無い状態は「未設定」で、推測した値で埋めない
 * - 書き込むのは設定画面（`src/web/home-settings.ts`）だけ。MCPからは読むだけ
 * - 壊れたファイルは上書きせず例外にする（未設定と取り違えて入力し直させない）
 * - 例外・ログに住所と座標を含めない
 */

export const HOME_PROFILE_PATH = resolve(DATA_DIR, "home-profile.json");

export const DEFAULT_LABEL = "自宅";
export const MAX_ACCESS_ROUTES = 20;

export interface HomeArea {
  prefecture: string | null;
  city: string | null;
  town: string | null;
  postalCode: string | null;
}

export interface HomeAccessRoute {
  /** 移動の `origin` と完全一致させる文字列（駅名など）。 */
  to: string;
  mode: TravelMode;
  typicalMinutes: number;
  bufferMinutes: number | null;
  /** 小さいほど優先する。 */
  priority: number;
}

export interface DeparturePreferences {
  defaultBufferMinutes: number | null;
  stationArrivalBufferMinutes: number | null;
  rainExtraMinutes: number | null;
}

export interface HomeProfileInput {
  label: string;
  area: HomeArea;
  exactAddress: string | null;
  coordinates: { latitude: number; longitude: number } | null;
  accessRoutes: HomeAccessRoute[];
  departurePreferences: DeparturePreferences;
}

export interface HomeProfile extends HomeProfileInput {
  updatedAt: string;
  /** 保存のたびに1増える。画面は読んだときの値を添えて保存し、行き違いを防ぐ。 */
  version: number;
}

type Validated = { ok: true; input: HomeProfileInput } | { ok: false; errors: string[] };

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** 型と範囲を検査して取り込む。保存前の入力と、読み出したファイルの両方に使う。 */
export function validateHomeProfile(raw: unknown): Validated {
  const errors: string[] = [];
  const source = object(raw);

  const text = (value: unknown, name: string, max: number): string | null => {
    if (value === null || value === undefined) return null;
    if (typeof value !== "string") {
      errors.push(`${name} は文字列で指定してください`);
      return null;
    }
    const trimmed = value.trim();
    if (trimmed.length > max) errors.push(`${name} は${max}文字以内で入力してください`);
    return trimmed || null;
  };
  const integer = (value: unknown, name: string, min: number, max: number): number | null => {
    if (value === null || value === undefined) return null;
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      errors.push(`${name} は${min}〜${max}の整数で入力してください`);
      return null;
    }
    return value;
  };

  const rawArea = object(source["area"]);
  const area: HomeArea = {
    prefecture: text(rawArea["prefecture"], "都道府県", 20),
    city: text(rawArea["city"], "市区町村", 50),
    town: text(rawArea["town"], "町域", 100),
    postalCode: text(rawArea["postalCode"], "郵便番号", 8),
  };
  if (area.postalCode && !/^\d{3}-?\d{4}$/.test(area.postalCode)) {
    errors.push("郵便番号は 123-4567 の形で入力してください");
  }

  let coordinates: HomeProfileInput["coordinates"] = null;
  if (source["coordinates"] !== null && source["coordinates"] !== undefined) {
    const { latitude, longitude } = object(source["coordinates"]);
    if (
      typeof latitude === "number" && Math.abs(latitude) <= 90 &&
      typeof longitude === "number" && Math.abs(longitude) <= 180
    ) {
      coordinates = { latitude, longitude };
    } else {
      errors.push("座標は緯度（-90〜90）と経度（-180〜180）の両方を数値で入力してください");
    }
  }

  const rawRoutes = Array.isArray(source["accessRoutes"]) ? source["accessRoutes"] : [];
  if (rawRoutes.length > MAX_ACCESS_ROUTES) errors.push(`区間は${MAX_ACCESS_ROUTES}件までです`);
  const accessRoutes: HomeAccessRoute[] = [];
  rawRoutes.forEach((entry, index) => {
    const route = object(entry);
    const at = `区間${index + 1}の`;
    const to = text(route["to"], `${at}行き先`, 200);
    const mode = TRAVEL_MODES.find((candidate) => candidate === route["mode"]);
    const typicalMinutes = integer(route["typicalMinutes"], `${at}所要時間`, 1, 600);
    const bufferMinutes = integer(route["bufferMinutes"], `${at}余裕時間`, 0, 240);
    const priority = integer(route["priority"], `${at}優先順`, 1, 99) ?? 1;
    if (!to) errors.push(`${at}行き先を入力してください`);
    if (!mode) errors.push(`${at}移動手段を選んでください`);
    if (route["typicalMinutes"] === null || route["typicalMinutes"] === undefined) {
      errors.push(`${at}所要時間を入力してください`);
    }
    if (to && mode && typicalMinutes !== null) {
      accessRoutes.push({ to, mode, typicalMinutes, bufferMinutes, priority });
    }
  });

  const rawPreferences = object(source["departurePreferences"]);
  const departurePreferences: DeparturePreferences = {
    defaultBufferMinutes: integer(rawPreferences["defaultBufferMinutes"], "出発の余裕時間", 0, 240),
    stationArrivalBufferMinutes: integer(rawPreferences["stationArrivalBufferMinutes"], "駅に着く余裕時間", 0, 240),
    rainExtraMinutes: integer(rawPreferences["rainExtraMinutes"], "雨の日の追加時間", 0, 240),
  };

  const input: HomeProfileInput = {
    label: text(source["label"], "呼び名", 50) ?? DEFAULT_LABEL,
    area,
    exactAddress: text(source["exactAddress"], "正確な住所", 300),
    coordinates,
    accessRoutes: accessRoutes.sort((a, b) => a.priority - b.priority),
    departurePreferences,
  };
  return errors.length > 0 ? { ok: false, errors } : { ok: true, input };
}

/** 呼び名のほかに何も入力されていないか。 */
export function isEmptyHomeProfile(input: HomeProfileInput): boolean {
  return (
    Object.values(input.area).every((value) => value === null) &&
    input.exactAddress === null &&
    input.coordinates === null &&
    input.accessRoutes.length === 0 &&
    Object.values(input.departurePreferences).every((value) => value === null)
  );
}

export type SaveOutcome =
  | { ok: true; profile: HomeProfile | null }
  /** 読んだあとに別の保存があった。上書きしない。 */
  | { ok: false; reason: "conflict" };

export interface HomeProfileStore {
  /** 未設定なら null。 */
  read(): Promise<HomeProfile | null>;
  /** `expectedVersion` は読んだときの版（未設定なら0）。中身が空なら削除して未設定へ戻す。 */
  save(input: HomeProfileInput, expectedVersion: number, now?: Date): Promise<SaveOutcome>;
}

export function createHomeProfileStore(path: string = HOME_PROFILE_PATH): HomeProfileStore {
  let queue: Promise<unknown> = Promise.resolve();
  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }

  async function read(): Promise<HomeProfile | null> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("自宅プロフィールの保存ファイルを読めません");
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const validated = validateHomeProfile(parsed);
      const { updatedAt, version } = parsed;
      if (!validated.ok || typeof updatedAt !== "string" || typeof version !== "number") throw new Error();
      return { ...validated.input, updatedAt, version };
    } catch {
      // JSON.parse の例外には中身の断片（住所）が載るため、投げ直す。
      throw new Error("自宅プロフィールの保存ファイルが壊れています。上書きせず停止します");
    }
  }

  async function write(profile: HomeProfile): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(profile, null, 2), { encoding: "utf8", mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  }

  return {
    read: () => serialize(read),
    save: (input, expectedVersion, now = new Date()) =>
      serialize(async (): Promise<SaveOutcome> => {
        const current = await read();
        if ((current?.version ?? 0) !== expectedVersion) return { ok: false, reason: "conflict" };
        if (isEmptyHomeProfile(input)) {
          if (current) await unlink(path);
          return { ok: true, profile: null };
        }
        const profile: HomeProfile = { ...input, updatedAt: now.toISOString(), version: expectedVersion + 1 };
        await write(profile);
        return { ok: true, profile };
      }),
  };
}

let shared: HomeProfileStore | undefined;
export function homeProfileStore(): HomeProfileStore {
  return (shared ??= createHomeProfileStore());
}
