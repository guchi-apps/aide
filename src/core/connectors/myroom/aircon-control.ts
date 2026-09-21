import type { MyRoomControlConfig } from "./control.ts";

/**
 * myroom 経由のエアコンの操作（aide#316。myroom側: guchi-apps/myroom#439）。
 *
 * 白くまくん（AirCloud Home）へ運転指示を送る仕組みは myroom が持っている（`backend/aircon_control.py`）。
 * **AIDEは白くまくんの資格情報もサインインも持たず、myroom の内部APIを叩くだけにする。**
 * 直接叩くと、ログイン状態・トークンの更新・レート制限（429）の管理が二重になる（照明操作 #317 と同じ理由）。
 *
 * README「書き込みをどこまで持つか」との対応:
 *
 * 1. **他のどこからも塞がっている経路。** myroom のエアコン操作はログインしたブラウザ専用で、
 *    Claude / ChatGPT から届く経路は他に無い
 * 2. **読み取りとは別の資格情報。** 照明の操作と同じ `AIDE_MYROOM_CONTROL_TOKEN`
 *    （読み取り用の `AIDE_MYROOM_TOKEN` とは別）。myroom側も `INTERNAL_CONTROL_API_KEY` だけで通す
 * 3. **例外。** 機器の状態を変える操作で、作成だけではない。ただし変更前の状態を応答に返すので、
 *    その値で元に戻せる
 *
 * **契約はAIDE側で先に決めた**（myroom#439 の実装より前）。myroom が未実装なら 404 が返り、
 * 何も送らずに `unsupported` として止まる。
 *
 * | myroom の内部API | 使うもの |
 * |---|---|
 * | `GET /api/internal/aircon/units/{ac_id}/state` | `fetchAirconState`（白くまくんから直接読む。DBの最新記録ではない） |
 * | `POST /api/internal/aircon/units/{ac_id}/control` | `sendAirconCommand`（受けるのは4項目だけ） |
 */

/** 状態を読むときの制限時間。myroom は白くまくんを直接叩く（初回はサインインも挟む）ため、DBを読むだけの3秒では足りない。 */
export const STATE_TIMEOUT_MS = 10_000;

/** 運転指示を送るときの制限時間。myroom は白くまくんへの通信を最大15秒待つので、それより長く取る。 */
export const CONTROL_TIMEOUT_MS = 20_000;

/** myroom の `MODES`（`backend/aircon_control.py`）と同じ。`DRY_COOL`（除湿冷房）は指定できない。 */
export const AIRCON_MODES = ["COOLING", "HEATING", "DRY", "FAN", "AUTO"] as const;
export const AIRCON_POWERS = ["ON", "OFF"] as const;
/** `LV1` が「静」で、数字が上がるほど強い。 */
export const AIRCON_FAN_SPEEDS = ["AUTO", "LV1", "LV2", "LV3", "LV4"] as const;

export const MIN_TEMPERATURE = 16;
export const MAX_TEMPERATURE = 32;
export const TEMPERATURE_STEP = 0.5;

/** 自動運転から他のモードへ切り替えたとき、温度の指定が無ければ myroom がこの値から始める。 */
export const DEFAULT_TARGET_TEMPERATURE = 26;

/** 変えたい項目。**指定しなかった項目は触らない**（myroom が現在値と混ぜて送る）。風向は対象外。 */
export interface AirconCommand {
  power?: (typeof AIRCON_POWERS)[number];
  mode?: (typeof AIRCON_MODES)[number];
  targetTemperature?: number;
  fanSpeed?: (typeof AIRCON_FAN_SPEEDS)[number];
}

/** エアコン1台のいまの状態。myroom の応答（snake_case）のうち、AIDEが使うものだけ。 */
export interface AirconState {
  acId: number | null;
  name: string;
  power: string;
  mode: string;
  roomTemperature: number | null;
  targetTemperature: number | null;
  fanSpeed: string;
  online: boolean;
}

export type AirconFailureKind =
  /** `AIDE_MYROOM_CONTROL_TOKEN` が myroom 側と一致しない */
  | "unauthorized"
  /** myroom がエアコンの内部APIを持たないバージョン（myroom#439 が未リリース） */
  | "unsupported"
  /** 指定したエアコンが白くまくんに見つからない */
  | "not_found"
  /** myroom 側の設定が足りない（操作用のキー・白くまくんのログイン情報が未設定） */
  | "unavailable"
  /** 白くまくんの混雑・回数制限（429） */
  | "rate_limited"
  /** myroom が指示を受け付けなかった（値の検証） */
  | "rejected"
  /** 接続できない・白くまくん側の失敗など。**送れていないことが確かなもの** */
  | "failed"
  /** 応答を待ちきれなかった。**送れたかどうか分からない** */
  | "unknown";

export type AirconFailure = { ok: false; kind: AirconFailureKind; reason: string; retryAfterSec?: number };

// --- 入力の検証 -------------------------------------------------------------

function pickChoice<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): { ok: true; value: T } | { ok: false; reason: string } {
  const text = typeof value === "string" ? value.trim().toUpperCase() : "";
  const found = allowed.find((candidate) => candidate === text);
  if (!found) return { ok: false, reason: `${label}に指定できない値です: ${String(value)}（${allowed.join(" / ")}）` };
  return { ok: true, value: found };
}

/**
 * ツールの引数から、変えたい項目を取り出す。**値を丸めない。**
 * 設定温度は0.5刻みの範囲内だけを受け、それ以外は黙って直さず断る（27.3 を 27.5 にして送ると、頼んだ値と違う）。
 */
export function parseAirconCommand(
  args: Record<string, unknown>,
): { ok: true; command: AirconCommand } | { ok: false; reason: string } {
  const command: AirconCommand = {};

  if (args["power"] !== undefined) {
    const picked = pickChoice(args["power"], AIRCON_POWERS, "電源");
    if (!picked.ok) return picked;
    command.power = picked.value;
  }
  if (args["mode"] !== undefined) {
    const picked = pickChoice(args["mode"], AIRCON_MODES, "運転モード");
    if (!picked.ok) return picked;
    command.mode = picked.value;
  }
  if (args["fanSpeed"] !== undefined) {
    const picked = pickChoice(args["fanSpeed"], AIRCON_FAN_SPEEDS, "風量");
    if (!picked.ok) return picked;
    command.fanSpeed = picked.value;
  }
  if (args["targetTemperature"] !== undefined) {
    const value = args["targetTemperature"];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { ok: false, reason: "設定温度は数値で指定してください" };
    }
    if (value < MIN_TEMPERATURE || value > MAX_TEMPERATURE) {
      return { ok: false, reason: `設定温度は${MIN_TEMPERATURE}〜${MAX_TEMPERATURE}℃の範囲で指定してください` };
    }
    if (Math.abs(value / TEMPERATURE_STEP - Math.round(value / TEMPERATURE_STEP)) > 1e-9) {
      return { ok: false, reason: `設定温度は${TEMPERATURE_STEP}℃刻みで指定してください` };
    }
    command.targetTemperature = value;
  }

  if (Object.keys(command).length === 0) {
    return { ok: false, reason: "変更する項目がありません（power・mode・targetTemperature・fanSpeed のどれかが要ります）" };
  }
  return { ok: true, command };
}

// --- 変更内容の組み立て ----------------------------------------------------

export interface AirconChange {
  field: "power" | "mode" | "targetTemperature" | "fanSpeed";
  from: string | number | null;
  to: string | number;
}

export interface AirconPlan {
  changes: AirconChange[];
  /** 現在値と同じ項目は入らない。空なら何も送る必要が無い。 */
  note?: string;
}

/**
 * 現在の状態と突き合わせて、**実際に変わる項目**だけを並べる。
 *
 * 絶対値で指定するので同じ指示を2回送っても結果は変わらないが、変わらない指示はそもそも送らない
 * （送れたか分からない状況での再試行が、白くまくんの回数制限を食うだけになるため）。
 */
export function planAirconChange(current: AirconState, command: AirconCommand): AirconPlan {
  const changes: AirconChange[] = [];
  if (command.power !== undefined && command.power !== current.power.toUpperCase()) {
    changes.push({ field: "power", from: current.power, to: command.power });
  }
  if (command.mode !== undefined && command.mode !== current.mode.toUpperCase()) {
    changes.push({ field: "mode", from: current.mode, to: command.mode });
  }
  if (command.targetTemperature !== undefined && command.targetTemperature !== current.targetTemperature) {
    changes.push({ field: "targetTemperature", from: current.targetTemperature, to: command.targetTemperature });
  }
  if (command.fanSpeed !== undefined && command.fanSpeed !== current.fanSpeed.toUpperCase()) {
    changes.push({ field: "fanSpeed", from: current.fanSpeed, to: command.fanSpeed });
  }

  const wasAuto = current.mode.toUpperCase() === "AUTO";
  const willBeAuto = (command.mode ?? current.mode).toUpperCase() === "AUTO";
  const plan: AirconPlan = { changes };
  if (command.mode !== undefined && wasAuto !== willBeAuto && command.targetTemperature === undefined) {
    // 自動運転の「設定温度」は室温からのシフト量で、他のモードとは意味が違う。myroom が既定値へ置き換える。
    plan.note = willBeAuto
      ? "自動運転へ切り替えるため、設定温度は室温からのシフト量0に置き換わります。"
      : `自動運転から切り替えるため、設定温度は既定の${DEFAULT_TARGET_TEMPERATURE}℃に置き換わります。`;
  }
  return plan;
}

/**
 * 自動運転の設定温度は室温からのシフト量で、「◯℃にして」とは意味が違う。
 * AIDE はその解釈をせず、自動運転になる指示に設定温度が付いていたら断る。
 */
export function conflictsWithAutoMode(current: AirconState, command: AirconCommand): boolean {
  if (command.targetTemperature === undefined) return false;
  return (command.mode ?? current.mode).toUpperCase() === "AUTO";
}

// --- myroom との通信 -------------------------------------------------------

async function readDetail(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as Record<string, unknown>;
    return typeof body["detail"] === "string" ? body["detail"] : undefined;
  } catch {
    return undefined;
  }
}

async function classifyResponseFailure(res: Response): Promise<AirconFailure> {
  const detail = await readDetail(res);
  if (res.status === 401) {
    return { ok: false, kind: "unauthorized", reason: "HTTP 401（AIDE_MYROOM_CONTROL_TOKEN が myroom 側と一致しない）" };
  }
  if (res.status === 404) {
    // FastAPI はルートが無いと `{"detail":"Not Found"}` を返す。エアコンが見つからない404と区別する。
    if (!detail || detail === "Not Found") {
      return {
        ok: false,
        kind: "unsupported",
        reason: "HTTP 404（myroom がエアコンの内部APIを持たないバージョン。guchi-apps/myroom#439）",
      };
    }
    return { ok: false, kind: "not_found", reason: detail };
  }
  if (res.status === 422) {
    return { ok: false, kind: "rejected", reason: detail ?? "myroom が指示を受け付けませんでした（HTTP 422）" };
  }
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after"));
    return {
      ok: false,
      kind: "rate_limited",
      reason: detail ?? "混み合っています。しばらく待ってからお試しください",
      ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSec: retryAfter } : {}),
    };
  }
  if (res.status === 503) {
    return {
      ok: false,
      kind: "unavailable",
      reason: detail ?? "HTTP 503（myroom 側で INTERNAL_CONTROL_API_KEY か白くまくんのログイン情報が未設定）",
    };
  }
  return { ok: false, kind: "failed", reason: detail ?? `HTTP ${res.status}` };
}

function classifyThrown(cause: unknown, timeoutMs: number, sending: boolean): AirconFailure {
  if (cause instanceof Error && cause.name === "TimeoutError") {
    return sending
      ? { ok: false, kind: "unknown", reason: `${timeoutMs}ms 以内に応答がありませんでした。送れたかどうかは分かりません` }
      : { ok: false, kind: "failed", reason: `${timeoutMs}ms 以内に応答がありませんでした` };
  }
  if (cause instanceof Error && cause.name === "SyntaxError") {
    // 送った場合、送信自体は済んでいて応答だけ読めなかった可能性がある。
    return sending
      ? { ok: false, kind: "unknown", reason: "応答をJSONとして読めませんでした。送れたかどうかは分かりません" }
      : { ok: false, kind: "failed", reason: "JSONとして読めない応答が返りました" };
  }
  return { ok: false, kind: "failed", reason: "myroom へ接続できませんでした" };
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** myroom の応答（`build_state`）を、AIDEが使う形へ。状態の形をしていなければ null。 */
export function toAirconState(raw: unknown): AirconState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const power = asText(record["power"]);
  const mode = asText(record["mode"]);
  if (!power && !mode) return null;
  return {
    acId: asNumber(record["ac_id"]),
    name: asText(record["name"]).trim(),
    power: power.toUpperCase(),
    mode: mode.toUpperCase(),
    roomTemperature: asNumber(record["room_temperature"]),
    targetTemperature: asNumber(record["target_temperature"]),
    fanSpeed: asText(record["fan_speed"]).toUpperCase(),
    online: record["online"] === true,
  };
}

function unitUrl(config: MyRoomControlConfig, acId: number, tail: "state" | "control"): string {
  return `${config.baseUrl}/api/internal/aircon/units/${encodeURIComponent(String(acId))}/${tail}`;
}

/** エアコン1台のいまの状態。DBの最新記録ではなく、白くまくんから直接読んだ値。 */
export async function fetchAirconState(
  config: MyRoomControlConfig,
  acId: number,
): Promise<{ ok: true; state: AirconState } | AirconFailure> {
  try {
    const res = await fetch(unitUrl(config, acId, "state"), {
      headers: { authorization: `Bearer ${config.token}`, accept: "application/json" },
      signal: AbortSignal.timeout(STATE_TIMEOUT_MS),
    });
    if (!res.ok) return await classifyResponseFailure(res);
    const state = toAirconState(await res.json());
    if (!state) return { ok: false, kind: "failed", reason: "myroom の応答からエアコンの状態を読めませんでした" };
    return { ok: true, state };
  } catch (cause) {
    return classifyThrown(cause, STATE_TIMEOUT_MS, false);
  }
}

/**
 * 運転指示を送る。成功は「myroom が白くまくんへ指示を送れた」まで（`state` は送信後の**想定**状態）。
 * 機器が実際にその状態になったかは、少し置いてから `fetchAirconState` で読み戻して確かめる。
 */
export async function sendAirconCommand(
  config: MyRoomControlConfig,
  acId: number,
  command: AirconCommand,
): Promise<{ ok: true; state: AirconState | null } | AirconFailure> {
  // myroom の `AirconControlCommand`（snake_case）へ。**指定された項目だけ**を送る。
  const body: Record<string, unknown> = {};
  if (command.power !== undefined) body["power"] = command.power;
  if (command.mode !== undefined) body["mode"] = command.mode;
  if (command.targetTemperature !== undefined) body["target_temperature"] = command.targetTemperature;
  if (command.fanSpeed !== undefined) body["fan_speed"] = command.fanSpeed;

  try {
    const res = await fetch(unitUrl(config, acId, "control"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.token}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    });
    if (!res.ok) return await classifyResponseFailure(res);
    return { ok: true, state: toAirconState(await res.json()) };
  } catch (cause) {
    return classifyThrown(cause, CONTROL_TIMEOUT_MS, true);
  }
}
