import { DEFAULT_BASE_URL, TIMEOUT_MS } from "./index.ts";

/**
 * myroom への操作。**Nature Remo に登録済みのボタン（照明のON/OFFなど）を押すことだけ**を持つ
 * （aide#317、myroom側: guchi-apps/myroom#419）。
 *
 * 操作そのものは myroom が持っている（`backend/remote.py`）。AIDEは Nature Remo を直接叩かず、
 * myroom の画面で登録済みのボタンをIDで押すだけにする。直接叩くと、ボタンの定義・表示名が
 * myroom と二重になり、Nature Remo のレート制限（30回/5分）も両者で食い合う。
 *
 * README「書き込みをどこまで持つか」との対応:
 *
 * 1. **他のどこからも塞がっている経路。** myroom の操作APIはログインしたブラウザ専用で、
 *    Claude / ChatGPT から部屋の機器へ届く経路は他に無い
 * 2. **読み取りとは別の資格情報。** 読み取り用の `AIDE_MYROOM_TOKEN` とは別の
 *    `AIDE_MYROOM_CONTROL_TOKEN` を使う。myroom側も読み取り用の `INTERNAL_API_KEY` とは別の
 *    `INTERNAL_CONTROL_API_KEY` で守り、片方が漏れてももう片方の経路は塞がったまま
 * 3. **例外。** 機器の状態を変える操作で、作成だけではない。ただし、押したボタンは逆のボタン
 *    （「消す」に対する「点ける」）を押せば戻せる。README の該当節を参照
 *
 * **押した結果は「myroom が Nature Remo へ送信を依頼できたか」までしか分からない。**
 * 赤外線は片方向で、機器が受け取ったかは返ってこない（myroom#106 の設計）。
 */

/**
 * 押すときの制限時間。myroom は Nature Remo の応答を最大10秒待つ（`SEND_TIMEOUT_SECONDS`）ので、
 * それより長く取る。短いと、myroom 側では送れているのにAIDEだけが失敗と判断してしまう。
 */
export const PRESS_TIMEOUT_MS = 15_000;

export interface MyRoomControlConfig {
  baseUrl: string;
  token: string;
}

/**
 * 操作用の設定を読む。トークンが無ければ null（＝叩きに行かない）。
 *
 * `AIDE_MYROOM_URL` は読み取り（`index.ts`）と共有する。同じ myroom を指すため。
 * **トークンは認証情報として扱う。** 戻り値をログ・レスポンスへ出さないこと。
 */
export function readMyRoomControlConfig(): MyRoomControlConfig | null {
  const token = process.env["AIDE_MYROOM_CONTROL_TOKEN"];
  if (!token) return null;

  const baseUrl = process.env["AIDE_MYROOM_URL"] ?? DEFAULT_BASE_URL;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token };
}

/** 押せるボタン1つ。`name` はClaudeが利用者へ復唱し、押すときに `expectedName` として返す名前。 */
export interface RoomButton {
  id: string;
  /** 「グループ名 / ボタン名」。例: `照明 / 点ける` */
  name: string;
  group: string;
  label: string;
  /** myroom のダッシュボードに出していないボタン。押すことはできる（myroom と同じ扱い）。 */
  hidden: boolean;
}

export type ControlFailureKind =
  /** `AIDE_MYROOM_CONTROL_TOKEN` が myroom 側と一致しない */
  | "unauthorized"
  /** myroom が操作用の内部APIを持たないバージョン（myroom#419 が未リリース） */
  | "unsupported"
  /** 指定したボタンが myroom に登録されていない */
  | "not_found"
  /** myroom 側の設定が足りない（操作用のキー・Nature Remo のトークンが未設定） */
  | "unavailable"
  /** Nature Remo の送信回数の上限 */
  | "rate_limited"
  /** 接続できない・Nature Remo 側の失敗など。**送れていないことが確かなもの** */
  | "failed"
  /** 応答を待ちきれなかった。**送れたかどうか分からない** */
  | "unknown";

export type ControlFailure = { ok: false; kind: ControlFailureKind; reason: string };

export function buttonName(group: string, label: string): string {
  return `${group} / ${label}`;
}

/** 比べるときは空白と区切りの揺れを無視する（「照明/点ける」「照明 点ける」を同じとみなす）。 */
export function normalizeName(value: string): string {
  return value.replace(/[\s/／・]+/g, "").toLowerCase();
}

/** myroom の `detail` は利用者向けの文言として作られているので、そのまま理由に使う。 */
async function readDetail(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as Record<string, unknown>;
    return typeof body["detail"] === "string" ? body["detail"] : undefined;
  } catch {
    return undefined;
  }
}

async function classifyResponseFailure(res: Response): Promise<ControlFailure> {
  const detail = await readDetail(res);
  if (res.status === 401) {
    return { ok: false, kind: "unauthorized", reason: "HTTP 401（AIDE_MYROOM_CONTROL_TOKEN が myroom 側と一致しない）" };
  }
  if (res.status === 404) {
    // FastAPI はルートが無いと `{"detail":"Not Found"}` を返す。登録されていないボタンの404と区別する。
    if (!detail || detail === "Not Found") {
      return {
        ok: false,
        kind: "unsupported",
        reason: "HTTP 404（myroom が操作用の内部APIを持たないバージョン。guchi-apps/myroom#419）",
      };
    }
    return { ok: false, kind: "not_found", reason: detail };
  }
  if (res.status === 429) {
    return {
      ok: false,
      kind: "rate_limited",
      reason: detail ?? "Nature Remo の送信回数の上限に達しました。しばらく待ってからお試しください",
    };
  }
  if (res.status === 503) {
    // myroom側で INTERNAL_CONTROL_API_KEY が未設定か、Nature Remo のトークンが未設定。どちらも送れていない。
    return {
      ok: false,
      kind: "unavailable",
      reason: detail ?? "HTTP 503（myroom 側で INTERNAL_CONTROL_API_KEY が未設定）",
    };
  }
  return { ok: false, kind: "failed", reason: detail ?? `HTTP ${res.status}` };
}

function classifyThrown(cause: unknown, timeoutMs: number, pressing: boolean): ControlFailure {
  if (cause instanceof Error && cause.name === "TimeoutError") {
    return pressing
      ? {
          ok: false,
          kind: "unknown",
          reason: `${timeoutMs}ms 以内に応答がありませんでした。送れたかどうかは分かりません`,
        }
      : { ok: false, kind: "failed", reason: `${timeoutMs}ms 以内に応答がありませんでした` };
  }
  if (cause instanceof Error && cause.name === "SyntaxError") {
    // 押した場合、送信自体は済んでいて応答だけ読めなかった可能性がある。
    return pressing
      ? { ok: false, kind: "unknown", reason: "応答をJSONとして読めませんでした。送れたかどうかは分かりません" }
      : { ok: false, kind: "failed", reason: "JSONとして読めない応答が返りました" };
  }
  return { ok: false, kind: "failed", reason: "myroom へ接続できませんでした" };
}

interface RawButtonsPayload {
  configured?: unknown;
  groups?: Array<{
    name?: unknown;
    buttons?: Array<{ id?: unknown; label?: unknown; hidden?: unknown }>;
  }>;
}

/** myroom の応答を、AIDEが使う形へ畳む。形の崩れたボタンは黙って落とす。 */
export function toRoomButtons(payload: RawButtonsPayload): RoomButton[] {
  const buttons: RoomButton[] = [];
  for (const group of Array.isArray(payload.groups) ? payload.groups : []) {
    const groupName = typeof group?.name === "string" ? group.name.trim() : "";
    if (!groupName) continue;
    for (const button of Array.isArray(group.buttons) ? group.buttons : []) {
      const id = typeof button?.id === "string" ? button.id.trim() : "";
      const label = typeof button?.label === "string" ? button.label.trim() : "";
      if (!id || !label) continue;
      buttons.push({
        id,
        name: buttonName(groupName, label),
        group: groupName,
        label,
        hidden: button.hidden === true,
      });
    }
  }
  return buttons;
}

/** 押せるボタンの一覧。myroom はここで Nature Remo を叩かない。 */
export async function fetchRoomButtons(
  config: MyRoomControlConfig,
): Promise<{ ok: true; buttons: RoomButton[] } | ControlFailure> {
  try {
    const res = await fetch(`${config.baseUrl}/api/internal/remote/buttons`, {
      headers: { authorization: `Bearer ${config.token}`, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return await classifyResponseFailure(res);
    return { ok: true, buttons: toRoomButtons((await res.json()) as RawButtonsPayload) };
  } catch (cause) {
    return classifyThrown(cause, TIMEOUT_MS, false);
  }
}

/** ボタンを1つ押す。成功は「myroom が Nature Remo へ送信を依頼できた」まで。 */
export async function pressRoomButton(
  config: MyRoomControlConfig,
  buttonId: string,
): Promise<{ ok: true } | ControlFailure> {
  try {
    const res = await fetch(
      `${config.baseUrl}/api/internal/remote/buttons/${encodeURIComponent(buttonId)}/send`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${config.token}`, accept: "application/json" },
        signal: AbortSignal.timeout(PRESS_TIMEOUT_MS),
      },
    );
    if (!res.ok) return await classifyResponseFailure(res);
    const payload = (await res.json()) as { sent?: unknown };
    if (payload.sent !== true) {
      return { ok: false, kind: "unknown", reason: "myroom の応答から送信できたかを読めませんでした" };
    }
    return { ok: true };
  } catch (cause) {
    return classifyThrown(cause, PRESS_TIMEOUT_MS, true);
  }
}
