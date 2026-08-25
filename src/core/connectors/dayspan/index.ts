import type { DaySpanSchedule } from "./types.ts";

/**
 * DaySpan コネクタ。
 *
 * 予定（Googleカレンダー）・タスクと日付リマインド（Notion）・移動は
 * [DaySpan](https://github.com/guchi-apps/dayspan) が既に1つのカレンダーへ統合している。
 * **AIDEはGoogleカレンダーへ直接繋がず、サーバー間参照用の読み取りAPI
 * （`GET /api/internal/schedule`）を叩くだけにする。**
 *
 * Googleカレンダー用のOAuthクライアントとリフレッシュトークン（AES-256-GCMで暗号化して
 * DBへ保存）はDaySpanが持っている（向こうのREADME「認可の分離」）。AIDEへ同じ認可経路を
 * もう1本作ると、同意画面・トークンの失効・再認可を2か所で面倒を見ることになる。
 * ops-dashboard・subscription-lists・myroom と同じ「既にある集約を横断ビューへ畳む」形。
 *
 * 両方とも同じVPS上で動くため localhost 経由で届き、相手を外部公開する必要がない。
 * `fetch` しか使わないので実行時依存も増えない。
 *
 * **キャッシュを挟まない。** README「取得と提供の分離」が分離を要求しているのは
 * Playwright巡回のような重い取得で、こちらは localhost へのHTTP GET。予定は直前に
 * 追加・変更されうるため、ジョブ間隔ぶん古い写しを返すと「この後の予定」に答えられなくなる。
 */

/** DaySpan は同じVPS上のPM2プロセス（Next.js・ポート3113）。 */
const DEFAULT_BASE_URL = "http://127.0.0.1:3113";

/**
 * 1本あたりの制限時間。
 *
 * **他のコネクタ（3秒）より長い。** DaySpanの内部APIは受けた同期リクエストの中で
 * Google Calendar と Notion のAPIを叩くため、localhost で完結する相手と違って
 * 外部サービスの応答時間がそのまま乗る。短く切りすぎると、相手が正常でも毎回
 * タイムアウトになる。それでもMCPの同期リクエスト内なので、上限は掛ける。
 */
const TIMEOUT_MS = 8_000;

export interface DaySpanConfig {
  baseUrl: string;
  token: string;
}

/** 取得範囲。DaySpan側のクエリパラメータにそのまま対応する。 */
export interface DaySpanScheduleQuery {
  /** `YYYY-MM-DD`。省略すると DaySpan 側の設定タイムゾーンでの「今日」になる。 */
  date?: string;
  /** `date` から何日ぶん取るか（1〜31）。 */
  days?: number;
  /** 期限切れタスクを何日前まで遡るか（0〜90）。**0 なら取りにいかない**（Notionへの往復が1回減る）。 */
  overdueDays?: number;
}

/**
 * 設定を読む。トークンが無ければ null（＝401を叩きに行かない）。
 *
 * **トークンは認証情報として扱う。** 戻り値をログ・レスポンスへ出さないこと。
 * 値は DaySpan 側の `INTERNAL_API_KEY` と同じで、片方だけ変えると連携が止まる。
 */
export function readDaySpanConfig(): DaySpanConfig | null {
  const token = process.env["AIDE_DAYSPAN_TOKEN"];
  if (!token) return null;

  const baseUrl = process.env["AIDE_DAYSPAN_URL"] ?? DEFAULT_BASE_URL;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token };
}

/**
 * 失敗の理由を、外へ出してよい粒度まで丸める。
 *
 * 例外の `message` にはURLが載ることがあり、URLが出ると内部の構成が漏れる。
 * HTTPステータスと例外の種別だけに落とす。
 */
export function describeFailure(cause: unknown): string {
  if (cause instanceof Response) {
    if (cause.status === 400) return "HTTP 400（date・days・overdueDays の指定が不正）";
    if (cause.status === 401) return "HTTP 401（トークンが一致しない）";
    if (cause.status === 404) return "HTTP 404（内部APIが未実装のバージョン）";
    // 対象ユーザーを引けない（DaySpan側の ALLOWED_GOOGLE_EMAILS が2件以上）ときもここ。
    if (cause.status === 500) return "HTTP 500（DaySpan側で対象ユーザーを特定できない可能性）";
    if (cause.status === 503) return "HTTP 503（相手側でAPIキーが未設定）";
    return `HTTP ${cause.status}`;
  }
  if (cause instanceof Error) {
    if (cause.name === "TimeoutError") return `${TIMEOUT_MS}ms 以内に応答しなかった`;
    if (cause.name === "SyntaxError") return "JSONとして読めない応答が返った";
    return "接続できなかった";
  }
  return "取得に失敗した";
}

/**
 * 予定・タスク・日付リマインド・移動を1回で取得する。整形は行わない
 * （`src/core/views/schedule.ts` の仕事）。
 *
 * **基準日は渡さなくてよい。** VPSのタイムゾーンはUTCだが、DaySpanは利用者の設定
 * タイムゾーン（既定 `Asia/Tokyo`）で日付を解釈するため、省略時の「今日」もそちらで決まる。
 */
export async function fetchSchedule(
  config: DaySpanConfig,
  query: DaySpanScheduleQuery = {},
): Promise<DaySpanSchedule> {
  const url = new URL(`${config.baseUrl}/api/internal/schedule`);
  if (query.date) url.searchParams.set("date", query.date);
  if (query.days !== undefined) url.searchParams.set("days", String(query.days));
  if (query.overdueDays !== undefined) {
    url.searchParams.set("overdueDays", String(query.overdueDays));
  }

  const res = await fetch(url, {
    headers: { authorization: `Bearer ${config.token}`, accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // ここで Response 自体を throw する。describeFailure がステータスだけを取り出す。
  if (!res.ok) throw res;
  return (await res.json()) as DaySpanSchedule;
}
