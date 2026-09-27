import { DEFAULT_BASE_URL, TIMEOUT_MS } from "./index.ts";

/**
 * DaySpanへの書き込み。予定の新規作成（aide#243、起点: guchi-apps/aide-bot#184）と、
 * 既存の予定の更新・削除（aide#493、起点: guchi-apps/aide-bot#372）を持つ。
 *
 * README「書き込みをどこまで持つか」の3条件に沿っている。
 *
 * 1. **他のどこからも塞がっている経路。** aide-bot（Messages APIを直接叩く自前のクライアント）から
 *    Googleカレンダーへ届く公開のリモートMCPは無い（README「基準は『Claudeアプリにコネクタが
 *    あるか』ではない」）
 * 2. **読み取りとは別の資格情報。** 読み取り用の `AIDE_DAYSPAN_TOKEN` とは別の
 *    `AIDE_DAYSPAN_WRITE_TOKEN` を使う。DaySpan側も読み取り用の `INTERNAL_API_KEY` とは別の
 *    `INTERNAL_EVENTS_API_KEY` で守っており、片方が漏れてももう片方の経路は塞がったまま
 * 3. **更新・削除は対象を名指しさせる。** 作成だけだった当初の3条件目は、aide#493で
 *    「`calendarId` と予定のIDで対象を指し、削除は現在のタイトルの一致も要る」へ変えた
 *    （DaySpan側が取り違えを `409` で止める。繰り返しの親・シリーズ全体は消せない）
 *
 * 正本はDaySpan側の
 * [docs/internal-api.md](https://github.com/guchi-apps/dayspan/blob/develop/docs/internal-api.md)
 * の `POST /api/internal/events` と `PATCH` / `DELETE /api/internal/events/[id]`。
 */

const TIME_KEY = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface DaySpanWriteConfig {
  baseUrl: string;
  token: string;
}

/**
 * 書き込み用の設定を読む。トークンが無ければ null（＝叩きに行かない）。
 *
 * `AIDE_DAYSPAN_URL` は読み取り（`index.ts`）と共有する。同じDaySpanを指すため、
 * URLまで別の環境変数に分ける理由が無い。
 */
export function readDaySpanWriteConfig(): DaySpanWriteConfig | null {
  const token = process.env["AIDE_DAYSPAN_WRITE_TOKEN"];
  if (!token) return null;

  const baseUrl = process.env["AIDE_DAYSPAN_URL"] ?? DEFAULT_BASE_URL;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token };
}

export interface CreateEventInput {
  title: string;
  /** `YYYY-MM-DD`。 */
  date: string;
  /** `HH:MM`。`endTime` とセットでのみ指定できる。両方省略で終日。 */
  startTime?: string;
  endTime?: string;
  location?: string;
  /** 省略時はDaySpan側の既定の保存先。 */
  calendarId?: string;
}

/** 実在する日付かまで見る。`2026-02-31` のような日付をDaySpan側の丸めに任せない。 */
function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * 受け取った引数を検査して入力へ変換する。
 *
 * **DaySpan側の検査（`POST /api/internal/events`）と同じ基準にそろえる。** 二重に持つと
 * 基準が食い違うが、ここで弾いておけば無効な内容のためだけにネットワークへ出ずに済む。
 */
export function normalizeCreateEventInput(
  raw: Record<string, unknown>,
): { input: CreateEventInput } | { error: string } {
  const title = typeof raw["title"] === "string" ? raw["title"].trim() : "";
  if (!title) return { error: "title が必要です" };

  const date = raw["date"];
  if (typeof date !== "string" || !isRealDate(date)) {
    return { error: "date は YYYY-MM-DD 形式の実在する日付で指定してください" };
  }

  const startTime = typeof raw["startTime"] === "string" ? raw["startTime"] : undefined;
  const endTime = typeof raw["endTime"] === "string" ? raw["endTime"] : undefined;
  if ((startTime === undefined) !== (endTime === undefined)) {
    return {
      error:
        "startTime と endTime は両方指定するか、両方省略してください" +
        "（片方だけでは終日か時刻ありかが決まりません）",
    };
  }
  if (startTime !== undefined && endTime !== undefined) {
    if (!TIME_KEY.test(startTime) || !TIME_KEY.test(endTime)) {
      return { error: "startTime・endTime は HH:MM 形式で指定してください" };
    }
    if (endTime <= startTime) {
      return { error: "endTime は startTime より後にしてください" };
    }
  }

  const location = typeof raw["location"] === "string" ? raw["location"].trim() : "";
  const calendarId = typeof raw["calendarId"] === "string" ? raw["calendarId"].trim() : "";

  return {
    input: {
      title,
      date,
      ...(startTime === undefined ? {} : { startTime }),
      ...(endTime === undefined ? {} : { endTime }),
      ...(location ? { location } : {}),
      ...(calendarId ? { calendarId } : {}),
    },
  };
}

/** 書き込みが失敗したときの分類。作成・更新・削除で共通。 */
export interface WriteFailure {
  ok: false;
  /**
   * - `invalid` … ここまでの検査をすり抜けた入力不正（DaySpan側が改めて弾いたもの）
   * - `unauthorized` … `AIDE_DAYSPAN_WRITE_TOKEN` がDaySpan側と一致しない・未設定
   * - `no_calendar` … 書き込めるカレンダーが無い・指定したカレンダーが無い
   * - `forbidden` … 指定したカレンダーの「使用」がオフ・書き込み不可
   * - `not_found` … 指定した予定が無い（更新・削除）
   * - `conflict` … 繰り返しの親・日をまたぐ予定・タイトル不一致（更新・削除）。何も変えていない
   * - `unresolvable` … DaySpan側で対象ユーザーを1人に決められない（設定不備）
   * - `failed` … 接続できない・タイムアウト・その他
   */
  kind:
    | "invalid"
    | "unauthorized"
    | "no_calendar"
    | "forbidden"
    | "not_found"
    | "conflict"
    | "unresolvable"
    | "failed";
  reason: string;
  /** `title_mismatch` のとき、予定の現在のタイトル。復唱と違う予定だったと利用者へ伝えるのに使う。 */
  currentTitle?: string;
}

export type CreateEventOutcome = { ok: true; id: string; url: string | null } | WriteFailure;

/** 非2xxの応答を、外へ出してよい粒度の理由へ丸める。 */
async function classifyResponseFailure(res: Response): Promise<WriteFailure> {
  let body: Record<string, unknown> | null = null;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }
  const message = typeof body?.["message"] === "string" ? body["message"] : undefined;
  const error = typeof body?.["error"] === "string" ? body["error"] : undefined;

  if (res.status === 401 || res.status === 503) {
    return {
      ok: false,
      kind: "unauthorized",
      reason: `HTTP ${res.status}（DaySpan側の AIDE_DAYSPAN_WRITE_TOKEN が一致しないか未設定）`,
    };
  }
  if (res.status === 404) {
    if (error === "event_not_found") {
      return { ok: false, kind: "not_found", reason: message ?? "指定した予定が見つかりません（すでに消えているか、IDが違います）。" };
    }
    return {
      ok: false,
      kind: "no_calendar",
      reason:
        message ??
        "書き込めるカレンダーがありません。DaySpanの設定でカレンダーを接続し、使用をオンにしてください。",
    };
  }
  if (res.status === 403) {
    return {
      ok: false,
      kind: "forbidden",
      reason: message ?? "指定したカレンダーは使用がオフか、書き込みできません。",
    };
  }
  if (res.status === 409) {
    const currentTitle = typeof body?.["currentTitle"] === "string" ? body["currentTitle"] : undefined;
    return {
      ok: false,
      kind: "conflict",
      reason: message ?? error ?? "HTTP 409（この予定は変更・削除できません。何も変えていません）",
      ...(currentTitle === undefined ? {} : { currentTitle }),
    };
  }
  if (res.status === 500) {
    return {
      ok: false,
      kind: "unresolvable",
      reason: "DaySpan側で対象ユーザーを1人に決められません（ALLOWED_GOOGLE_EMAILS の設定を確認してください）",
    };
  }
  if (res.status === 400) {
    return { ok: false, kind: "invalid", reason: message ?? error ?? "HTTP 400（入力を確認してください）" };
  }
  return { ok: false, kind: "failed", reason: `HTTP ${res.status}` };
}

/** 接続できない・タイムアウトなどの例外を、外へ出してよい粒度の理由へ丸める。 */
function classifyThrown(cause: unknown): WriteFailure {
  if (cause instanceof Error && cause.name === "TimeoutError") {
    return { ok: false, kind: "failed", reason: `${TIMEOUT_MS}ms 以内に応答しませんでした` };
  }
  if (cause instanceof Error && cause.name === "SyntaxError") {
    return { ok: false, kind: "failed", reason: "JSONとして読めない応答が返りました" };
  }
  return { ok: false, kind: "failed", reason: "DaySpanへ接続できませんでした" };
}

function writeHeaders(config: DaySpanWriteConfig, withBody: boolean): Record<string, string> {
  return {
    authorization: `Bearer ${config.token}`,
    ...(withBody ? { "content-type": "application/json" } : {}),
    accept: "application/json",
  };
}

/** 予定を1件作成する。応答から `id` と、案内に使える `url` を返す。 */
export async function createDaySpanEvent(
  config: DaySpanWriteConfig,
  input: CreateEventInput,
): Promise<CreateEventOutcome> {
  try {
    const res = await fetch(`${config.baseUrl}/api/internal/events`, {
      method: "POST",
      headers: writeHeaders(config, true),
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return await classifyResponseFailure(res);

    const payload = (await res.json()) as { id?: unknown; url?: unknown };
    if (typeof payload.id !== "string") {
      return { ok: false, kind: "failed", reason: "DaySpanの応答から予定のIDを読めませんでした" };
    }
    return { ok: true, id: payload.id, url: typeof payload.url === "string" ? payload.url : null };
  } catch (cause) {
    return classifyThrown(cause);
  }
}

const EVENT_ID_KEY = /^[A-Za-z0-9_-]+$/;

export interface UpdateEventInput {
  eventId: string;
  /** 予定のあるカレンダー（`aide_schedule` の各予定の `calendarId`）。 */
  calendarId: string;
  title?: string;
  date?: string;
  /** 時刻ありの予定の終了日。省略時は開始日と同じ。 */
  endDate?: string;
  startTime?: string;
  endTime?: string;
  allDay?: boolean;
  /** 空文字で場所を消す。 */
  location?: string;
  tentative?: boolean;
}

/** 更新・削除の対象を指す `eventId` と `calendarId` を取り出す。 */
function readTarget(
  raw: Record<string, unknown>,
): { eventId: string; calendarId: string } | { error: string } {
  const eventId = typeof raw["eventId"] === "string" ? raw["eventId"].trim() : "";
  if (!eventId || !EVENT_ID_KEY.test(eventId)) {
    return { error: "eventId が必要です（aide_schedule が返した予定の id を、そのまま指定してください）" };
  }
  const calendarId = typeof raw["calendarId"] === "string" ? raw["calendarId"].trim() : "";
  if (!calendarId) {
    return { error: "calendarId が必要です（aide_schedule が返した予定の calendarId を、そのまま指定してください）" };
  }
  return { eventId, calendarId };
}

/**
 * 更新の入力を検査する。**DaySpan側（`PATCH /api/internal/events/[id]`）と同じ基準。**
 * 送った項目だけを変えるため、省略は「変えない」を意味する。
 */
export function normalizeUpdateEventInput(
  raw: Record<string, unknown>,
): { input: UpdateEventInput } | { error: string } {
  const target = readTarget(raw);
  if ("error" in target) return target;

  const fields: Omit<UpdateEventInput, "eventId" | "calendarId"> = {};

  if (raw["title"] !== undefined) {
    const title = typeof raw["title"] === "string" ? raw["title"].trim() : "";
    if (!title) return { error: "title は空にできません（変えないなら省いてください）" };
    fields.title = title;
  }
  if (raw["date"] !== undefined) {
    if (typeof raw["date"] !== "string" || !isRealDate(raw["date"])) {
      return { error: "date は YYYY-MM-DD 形式の実在する日付で指定してください" };
    }
    fields.date = raw["date"];
  }
  if (raw["endDate"] !== undefined) {
    if (typeof raw["endDate"] !== "string" || !isRealDate(raw["endDate"])) {
      return { error: "endDate は YYYY-MM-DD 形式の実在する日付で指定してください" };
    }
    if (typeof raw["date"] !== "string") {
      return { error: "endDate を指定するときは date も指定してください" };
    }
    if (raw["endDate"] < raw["date"]) {
      return { error: "endDate は date 以降の日付にしてください" };
    }
    fields.endDate = raw["endDate"];
  }

  const startTime = typeof raw["startTime"] === "string" ? raw["startTime"] : undefined;
  const endTime = typeof raw["endTime"] === "string" ? raw["endTime"] : undefined;
  if ((startTime === undefined) !== (endTime === undefined)) {
    return { error: "startTime と endTime は両方指定するか、両方省略してください" };
  }
  if (startTime !== undefined && endTime !== undefined) {
    if (!TIME_KEY.test(startTime) || !TIME_KEY.test(endTime)) {
      return { error: "startTime・endTime は HH:MM 形式で指定してください" };
    }
    if (fields.endDate === undefined || fields.endDate === fields.date) {
      if (endTime <= startTime) return { error: "同日の endTime は startTime より後にしてください" };
    }
    fields.startTime = startTime;
    fields.endTime = endTime;
  }

  if (raw["allDay"] !== undefined) {
    if (typeof raw["allDay"] !== "boolean") return { error: "allDay は true / false で指定してください" };
    if (raw["allDay"] && (startTime !== undefined || fields.endDate !== undefined)) {
      return { error: "allDay: true のときは startTime・endTime・endDate を同時に指定できません" };
    }
    fields.allDay = raw["allDay"];
  }
  if (raw["location"] !== undefined) {
    if (typeof raw["location"] !== "string") return { error: "location は文字列で指定してください" };
    fields.location = raw["location"].trim();
  }
  if (raw["tentative"] !== undefined) {
    if (typeof raw["tentative"] !== "boolean") return { error: "tentative は true / false で指定してください" };
    fields.tentative = raw["tentative"];
  }

  if (Object.keys(fields).length === 0) {
    return { error: "変える項目（title・date・endDate・startTime と endTime・allDay・location・tentative）を1つ以上指定してください" };
  }
  return { input: { ...target, ...fields } };
}

/** 予定を1件更新する。送った項目だけが変わる。 */
export async function updateDaySpanEvent(
  config: DaySpanWriteConfig,
  input: UpdateEventInput,
): Promise<CreateEventOutcome> {
  const { eventId, ...body } = input;
  try {
    const res = await fetch(`${config.baseUrl}/api/internal/events/${encodeURIComponent(eventId)}`, {
      method: "PATCH",
      headers: writeHeaders(config, true),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return await classifyResponseFailure(res);

    const payload = (await res.json()) as { id?: unknown; url?: unknown };
    return {
      ok: true,
      id: typeof payload.id === "string" ? payload.id : eventId,
      url: typeof payload.url === "string" ? payload.url : null,
    };
  } catch (cause) {
    return classifyThrown(cause);
  }
}

export interface DeleteEventInput {
  eventId: string;
  calendarId: string;
  /** 削除する予定の**現在のタイトル**。DaySpan側が一致を確かめ、違えば消さない。 */
  title: string;
}

export function normalizeDeleteEventInput(
  raw: Record<string, unknown>,
): { input: DeleteEventInput } | { error: string } {
  const target = readTarget(raw);
  if ("error" in target) return target;
  const title = typeof raw["title"] === "string" ? raw["title"].trim() : "";
  if (!title) {
    return { error: "title が必要です（消す予定の現在のタイトルを、利用者へ復唱した内容のまま指定してください）" };
  }
  return { input: { ...target, title } };
}

export type DeleteEventOutcome = { ok: true } | WriteFailure;

/** 予定を1回分だけ削除する。タイトルが違えばDaySpan側が `409` で止める。 */
export async function deleteDaySpanEvent(
  config: DaySpanWriteConfig,
  input: DeleteEventInput,
): Promise<DeleteEventOutcome> {
  const query = new URLSearchParams({ calendarId: input.calendarId, title: input.title });
  try {
    const res = await fetch(
      `${config.baseUrl}/api/internal/events/${encodeURIComponent(input.eventId)}?${query}`,
      {
        method: "DELETE",
        headers: writeHeaders(config, false),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!res.ok) return await classifyResponseFailure(res);
    return { ok: true };
  } catch (cause) {
    return classifyThrown(cause);
  }
}
