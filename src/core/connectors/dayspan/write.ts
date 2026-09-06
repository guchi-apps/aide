import { DEFAULT_BASE_URL, TIMEOUT_MS } from "./index.ts";

/**
 * DaySpanへの書き込み。**予定の新規作成だけ**を持つ（aide#243、起点: guchi-apps/aide-bot#184）。
 *
 * README「書き込みをどこまで持つか」の3条件に沿っている。
 *
 * 1. **他のどこからも塞がっている経路。** aide-bot（Messages APIを直接叩く自前のクライアント）から
 *    Googleカレンダーへ届く公開のリモートMCPは無い（README「基準は『Claudeアプリにコネクタが
 *    あるか』ではない」）
 * 2. **読み取りとは別の資格情報。** 読み取り用の `AIDE_DAYSPAN_TOKEN` とは別の
 *    `AIDE_DAYSPAN_WRITE_TOKEN` を使う。DaySpan側も読み取り用の `INTERNAL_API_KEY` とは別の
 *    `INTERNAL_EVENTS_API_KEY` で守っており、片方が漏れてももう片方の経路は塞がったまま
 * 3. **作成だけ。** 編集・削除は持たない。動かす・消すにはDaySpanの画面から行う
 *
 * 正本はDaySpan側の
 * [docs/internal-api.md](https://github.com/guchi-apps/dayspan/blob/main/docs/internal-api.md)
 * の `POST /api/internal/events`。
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

export type CreateEventOutcome =
  | { ok: true; id: string; url: string | null }
  | {
      ok: false;
      /**
       * - `invalid` … ここまでの検査をすり抜けた入力不正（DaySpan側が改めて弾いたもの）
       * - `unauthorized` … `AIDE_DAYSPAN_WRITE_TOKEN` がDaySpan側と一致しない・未設定
       * - `no_calendar` … 書き込めるカレンダーが無い（`calendarId` 省略時）
       * - `unresolvable` … DaySpan側で対象ユーザーを1人に決められない（設定不備）
       * - `failed` … 接続できない・タイムアウト・その他
       */
      kind: "invalid" | "unauthorized" | "no_calendar" | "unresolvable" | "failed";
      reason: string;
    };

/** 非2xxの応答を、外へ出してよい粒度の理由へ丸める。 */
async function classifyResponseFailure(res: Response): Promise<CreateEventOutcome> {
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
    return {
      ok: false,
      kind: "no_calendar",
      reason:
        message ??
        "書き込めるカレンダーがありません。DaySpanの設定でカレンダーを接続し、使用をオンにしてください。",
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
    return { ok: false, kind: "invalid", reason: error ?? "HTTP 400（入力を確認してください）" };
  }
  return { ok: false, kind: "failed", reason: `HTTP ${res.status}` };
}

/** 予定を1件作成する。応答から `id` と、案内に使える `url` を返す。 */
export async function createDaySpanEvent(
  config: DaySpanWriteConfig,
  input: CreateEventInput,
): Promise<CreateEventOutcome> {
  try {
    const res = await fetch(`${config.baseUrl}/api/internal/events`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
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
    if (cause instanceof Error && cause.name === "TimeoutError") {
      return { ok: false, kind: "failed", reason: `${TIMEOUT_MS}ms 以内に応答しませんでした` };
    }
    if (cause instanceof Error && cause.name === "SyntaxError") {
      return { ok: false, kind: "failed", reason: "JSONとして読めない応答が返りました" };
    }
    return { ok: false, kind: "failed", reason: "DaySpanへ接続できませんでした" };
  }
}
