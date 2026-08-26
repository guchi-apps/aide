/**
 * DaySpan の `GET /api/internal/schedule` のレスポンスのうち、
 * **AIDEが実際に使うフィールドだけ**を再宣言したもの。
 *
 * 別リポジトリなので型をimportできない、というだけの理由ではない。**使う範囲を明示的に
 * 絞ること自体が目的**で、向こうが画面都合でフィールドを足しても、ここに書いていない限り
 * AIDEは影響を受けない。逆に、ここに書いたフィールドが消えたら型ではなく実行時に
 * `undefined` として現れるため、扱いは常に「無いかもしれない」前提で書く。
 *
 * 正本は DaySpan 側の
 * [docs/internal-api.md](https://github.com/guchi-apps/dayspan/blob/develop/docs/internal-api.md)。
 */

/** Googleカレンダーの予定1件。 */
export interface DaySpanEvent {
  id: string;
  title?: string;
  allDay?: boolean;
  /** 開始（ISO8601）。**終日は `YYYY-MM-DD`。** */
  start?: string;
  end?: string;
  /** 設定タイムゾーンでの `HH:MM`。終日は null。**AIDE側で時刻を組み立て直さない。** */
  startTime?: string | null;
  endTime?: string | null;
  location?: string | null;
  description?: string | null;
  /** 元のカレンダー名（「仕事」など）。 */
  calendarName?: string | null;
  recurring?: boolean;
  url?: string | null;
}

/** Notionのタスク1件（その日に期限または予定日があるもの）。 */
export interface DaySpanTask {
  id: string;
  title?: string;
  /** `due`（期限）か `planned`（予定日）か。 */
  field?: string;
  date?: string;
  hasTime?: boolean;
  /** `HH:MM`。時刻なしは null。 */
  time?: string | null;
  priority?: string | null;
  tags?: string[];
  memo?: string | null;
  url?: string | null;
}

/** 記念日・更新日など、完了を持たない日付リマインド1件。 */
export interface DaySpanReminder {
  id: string;
  title?: string;
  date?: string;
  hasTime?: boolean;
  time?: string | null;
  category?: string | null;
  /** 毎年の項目か。判断できないときは null。 */
  annual?: boolean | null;
  /** `reminder` か `garbage`（ゴミの収集日）。 */
  source?: string;
  memo?: string | null;
  url?: string | null;
}

/** 移動1件。DaySpanのDBが持つもので、Googleカレンダー由来ではない。 */
export interface DaySpanTravel {
  id: string;
  title?: string;
  origin?: string | null;
  destination?: string | null;
  /** `TRAIN` / `CAR` / `BUS` / `WALK` / `BICYCLE` / `PLANE` / `OTHER`。 */
  mode?: string | null;
  start?: string;
  end?: string;
  startTime?: string | null;
  endTime?: string | null;
  /** 所要時間がAIの見積もりかどうか（目安）。 */
  estimated?: boolean;
  returnLeg?: boolean;
  note?: string | null;
}

/** 1日ぶん。 */
export interface DaySpanDay {
  date: string;
  events?: DaySpanEvent[];
  tasks?: DaySpanTask[];
  reminders?: DaySpanReminder[];
  travels?: DaySpanTravel[];
}

/** 期限切れのタスク（`range.from` より前に期限が過ぎているもの）。 */
export interface DaySpanOverdueTask {
  id: string;
  title?: string;
  due?: string;
  hasTime?: boolean;
  time?: string | null;
  /** `range.from` から見て何日過ぎているか。 */
  daysOverdue?: number;
  priority?: string | null;
  tags?: string[];
  url?: string | null;
}

/**
 * 連携そのものの状態。
 *
 * **これが無いと「今日は何も無い」と「取得できていない」を区別できない。**
 * Google未接続・NotionのDB未設定は DaySpan 側で「失敗」扱いにならず、
 * `errors` に出ないまま該当する配列が空で返る。
 */
export interface DaySpanSources {
  googleConnected?: boolean;
  notionReady?: boolean;
  reminderReady?: boolean;
}

/** 部分的な取得失敗。DaySpanはHTTP 200のままこれに載せてくる。 */
export interface DaySpanError {
  source?: string;
  reason?: string;
}

/** `GET /api/internal/schedule` のレスポンス。 */
export interface DaySpanSchedule {
  /** DaySpanが応答を組み立てた時刻（ISO8601）。 */
  generatedAt?: string;
  /** 日付の解釈に使ったタイムゾーン（既定 `Asia/Tokyo`）。 */
  timeZone?: string;
  range?: { from?: string; to?: string };
  sources?: DaySpanSources;
  days?: DaySpanDay[];
  overdueTasks?: DaySpanOverdueTask[];
  errors?: DaySpanError[];
}

/** 取得できなかった理由。落ちたこと自体が状態なので、握りつぶさず返す。 */
export interface DaySpanFailure {
  source: string;
  /** 失敗の理由。**URL・ヘッダ・トークンは載せない**（HTTPステータスと例外名まで）。 */
  reason: string;
}
