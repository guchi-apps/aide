import {
  describeFailure,
  fetchSchedule,
  readDaySpanConfig,
  type DaySpanScheduleQuery,
} from "../connectors/dayspan/index.ts";
import type {
  DaySpanDay,
  DaySpanEvent,
  DaySpanFailure,
  DaySpanOverdueTask,
  DaySpanReminder,
  DaySpanSchedule,
  DaySpanTask,
  DaySpanTravel,
} from "../connectors/dayspan/types.ts";

/**
 * 予定の横断ビュー（aide#173）。
 *
 * DaySpan が統合済みの1日ぶん（Googleカレンダーの予定・Notionのタスクと日付リマインド・移動）を
 * 受け取り、**「その日が何で埋まっていて、どこが空いているか」**に答えられる粒度へ畳む。
 *
 * **空き時間はAIDE側で算出する。** DaySpanは表示用のアプリで、空き時間という概念を持たない。
 * とはいえ計算に使うのは向こうが設定タイムゾーンで描いた `HH:MM` だけで、こちらで
 * タイムゾーンを解釈し直さない（解釈し直すと、画面で見た時刻と食い違う）。
 *
 * **キャッシュを挟まず、呼ばれるたびに取得する**（`src/core/connectors/dayspan/index.ts`）。
 */

/** 空き時間を数える1日の時間帯。夜中を空きとして数えても答えが良くならない。 */
export const DEFAULT_FREE_WINDOW = { from: "08:00", to: "22:00" } as const;

/** これより短い隙間は空き時間として数えない（移動と準備で消える長さのため）。 */
export const MIN_FREE_MINUTES = 30;

/** 曜日。`YYYY-MM-DD` から求める（暦日の計算なのでタイムゾーンに依らない）。 */
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

export interface TimeWindow {
  from: string;
  to: string;
}

export interface ScheduleEvent {
  title: string;
  allDay: boolean;
  /** 設定タイムゾーンでの `HH:MM`。終日は null。 */
  startTime: string | null;
  endTime: string | null;
  location: string | null;
  calendarName: string | null;
  recurring: boolean;
  url: string | null;
}

export interface ScheduleTravel {
  title: string;
  origin: string | null;
  destination: string | null;
  /** `TRAIN` / `CAR` / `WALK` など。DaySpanの文字列そのまま。 */
  mode: string | null;
  startTime: string | null;
  endTime: string | null;
  /** 所要時間がAIの見積もりかどうか（目安であって確定ではない）。 */
  estimated: boolean;
}

export interface ScheduleTask {
  title: string;
  /** `due`（期限）か `planned`（予定日）か。 */
  kind: string;
  /** `HH:MM`。時刻の指定が無ければ null。 */
  time: string | null;
  priority: string | null;
  tags: string[];
  url: string | null;
}

export interface ScheduleReminder {
  title: string;
  time: string | null;
  category: string | null;
  /** 毎年の項目か。判断できなければ null。 */
  annual: boolean | null;
  /** `reminder` か `garbage`（ゴミの収集日）。 */
  kind: string;
}

export interface ScheduleOverdueTask {
  title: string;
  due: string | null;
  daysOverdue: number | null;
  priority: string | null;
  url: string | null;
}

/** 空いている時間帯1つぶん。 */
export interface FreeSlot {
  from: string;
  to: string;
  minutes: number;
}

export interface ScheduleDay {
  /** `YYYY-MM-DD`。 */
  date: string;
  /** 日本語1文字の曜日。 */
  weekday: string;
  events: ScheduleEvent[];
  travels: ScheduleTravel[];
  tasks: ScheduleTask[];
  reminders: ScheduleReminder[];
  /**
   * `freeWindow` の範囲内で、時刻の決まった予定・移動のどれとも重ならない時間帯。
   * **終日の予定は塞がない**（時間帯を持たないため）。
   */
  freeSlots: FreeSlot[];
  /** `freeWindow` の範囲内が予定・移動で埋まっている分数。 */
  busyMinutes: number;
  /** 時間帯を持たない予定の件数（終日）。 */
  allDayCount: number;
}

export interface ScheduleSummary {
  checkedAt: string;
  /** DaySpanへの接続が設定されているか。false なら以下はすべて空。 */
  configured: boolean;
  /** 予定を取得できたか。false なら「その日に予定が無い」という意味ではない。 */
  complete: boolean;
  /** DaySpanが日付の解釈に使ったタイムゾーン。 */
  timezone: string | null;
  /** DaySpanが応答を組み立てた時刻。 */
  generatedAt: string | null;
  range: { from: string; to: string } | null;
  /** 空き時間を数えた1日の時間帯。 */
  freeWindow: TimeWindow;
  /**
   * 連携そのものの状態。`googleConnected` が false なら、予定が空でも
   * 「予定が無い」ではなく「Googleカレンダーに繋がっていない」という意味になる。
   */
  sources: { googleConnected: boolean | null; notionReady: boolean | null; reminderReady: boolean | null };
  days: ScheduleDay[];
  /** 期限切れのタスク。`includeOverdueTasks` を指定したときだけ入る。 */
  overdueTasks: ScheduleOverdueTask[];
  /** 取得できなかった／設定されていないソース。 */
  unavailable: DaySpanFailure[];
  note: string;
}

function text(value: string | null | undefined): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** `HH:MM` を0時からの分数へ。読めなければ null。 */
export function parseClock(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 24 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** 0時からの分数を `HH:MM` へ。 */
export function formatClock(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** `YYYY-MM-DD` の曜日。 */
export function weekdayOf(date: string): string {
  const at = new Date(`${date}T00:00:00Z`);
  const index = at.getUTCDay();
  return Number.isNaN(index) ? "?" : (WEEKDAYS[index] ?? "?");
}

/**
 * 塞がっている時間帯を、窓の内側へ収めて重なりを潰す。**純粋関数。**
 *
 * **日付をまたぐ予定（終了が開始より前）は、その日の窓の終わりまでとして扱う。**
 * 翌日の枠へ持ち越すと、DaySpanが日ごとに振り分けた結果と食い違う。
 */
export function mergeBusy(
  intervals: { start: number; end: number }[],
  window: { start: number; end: number },
): { start: number; end: number }[] {
  const clamped = intervals
    .map(({ start, end }) => ({
      start: Math.max(start, window.start),
      end: Math.min(end <= start ? window.end : end, window.end),
    }))
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start - b.start);

  const merged: { start: number; end: number }[] = [];
  for (const interval of clamped) {
    const last = merged.at(-1);
    if (last && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

/**
 * 空いている時間帯を求める。**純粋関数。テストはここに集中する。**
 *
 * 時刻を持たないもの（終日の予定・時刻なしのタスク）は塞がない。時間帯が分からない以上、
 * 空きとして数えないと1日が丸ごと埋まったことになり、答えが常に「空きなし」になる。
 */
export function computeFreeSlots(
  busy: { startTime?: string | null; endTime?: string | null }[],
  window: TimeWindow = DEFAULT_FREE_WINDOW,
  minMinutes: number = MIN_FREE_MINUTES,
): { freeSlots: FreeSlot[]; busyMinutes: number } {
  const windowStart = parseClock(window.from) ?? 0;
  const windowEnd = parseClock(window.to) ?? 24 * 60;
  if (windowEnd <= windowStart) return { freeSlots: [], busyMinutes: 0 };

  const intervals: { start: number; end: number }[] = [];
  for (const entry of busy) {
    const start = parseClock(entry.startTime);
    const end = parseClock(entry.endTime);
    // 両端が揃っているものだけを塞ぐ。終了時刻だけ欠けたものへ既定の長さを当てると、
    // 実際には空いている時間を「埋まっている」と報告することになる。
    if (start === null || end === null) continue;
    intervals.push({ start, end });
  }

  const merged = mergeBusy(intervals, { start: windowStart, end: windowEnd });
  const freeSlots: FreeSlot[] = [];
  let cursor = windowStart;
  for (const interval of merged) {
    if (interval.start - cursor >= minMinutes) {
      freeSlots.push({
        from: formatClock(cursor),
        to: formatClock(interval.start),
        minutes: interval.start - cursor,
      });
    }
    cursor = Math.max(cursor, interval.end);
  }
  if (windowEnd - cursor >= minMinutes) {
    freeSlots.push({
      from: formatClock(cursor),
      to: formatClock(windowEnd),
      minutes: windowEnd - cursor,
    });
  }

  const busyMinutes = merged.reduce((total, interval) => total + (interval.end - interval.start), 0);
  return { freeSlots, busyMinutes };
}

function summarizeEvent(event: DaySpanEvent): ScheduleEvent {
  return {
    title: text(event.title) ?? "（無題の予定）",
    allDay: event.allDay === true,
    startTime: text(event.startTime),
    endTime: text(event.endTime),
    location: text(event.location),
    calendarName: text(event.calendarName),
    recurring: event.recurring === true,
    url: text(event.url),
  };
}

function summarizeTravel(travel: DaySpanTravel): ScheduleTravel {
  return {
    title: text(travel.title) ?? "（移動）",
    origin: text(travel.origin),
    destination: text(travel.destination),
    mode: text(travel.mode),
    startTime: text(travel.startTime),
    endTime: text(travel.endTime),
    estimated: travel.estimated === true,
  };
}

function summarizeTask(task: DaySpanTask): ScheduleTask {
  return {
    title: text(task.title) ?? "（無題のタスク）",
    kind: text(task.field) ?? "due",
    time: text(task.time),
    priority: text(task.priority),
    tags: Array.isArray(task.tags) ? task.tags.filter((tag) => typeof tag === "string") : [],
    url: text(task.url),
  };
}

function summarizeReminder(reminder: DaySpanReminder): ScheduleReminder {
  return {
    title: text(reminder.title) ?? "（無題）",
    time: text(reminder.time),
    category: text(reminder.category),
    annual: typeof reminder.annual === "boolean" ? reminder.annual : null,
    kind: text(reminder.source) ?? "reminder",
  };
}

function summarizeOverdueTask(task: DaySpanOverdueTask): ScheduleOverdueTask {
  return {
    title: text(task.title) ?? "（無題のタスク）",
    due: text(task.due),
    daysOverdue: typeof task.daysOverdue === "number" ? task.daysOverdue : null,
    priority: text(task.priority),
    url: text(task.url),
  };
}

/** 1日ぶんを畳む。**純粋関数。** */
export function summarizeDay(day: DaySpanDay, window: TimeWindow = DEFAULT_FREE_WINDOW): ScheduleDay {
  const events = (day.events ?? []).map(summarizeEvent);
  const travels = (day.travels ?? []).map(summarizeTravel);
  // 終日の予定は時間帯を持たないので、空きの計算には入れない。
  const { freeSlots, busyMinutes } = computeFreeSlots(
    [...events.filter((event) => !event.allDay), ...travels],
    window,
  );

  return {
    date: day.date,
    weekday: weekdayOf(day.date),
    events,
    travels,
    tasks: (day.tasks ?? []).map(summarizeTask),
    reminders: (day.reminders ?? []).map(summarizeReminder),
    freeSlots,
    busyMinutes,
    allDayCount: events.filter((event) => event.allDay).length,
  };
}

/**
 * 取得結果を「その日が何で埋まっていて、どこが空いているか」の粒度へ畳む。
 * **純粋関数。テストはここに集中する。**
 */
export function summarizeSchedule(
  schedule: DaySpanSchedule,
  now: Date,
  window: TimeWindow = DEFAULT_FREE_WINDOW,
): ScheduleSummary {
  const days = (schedule.days ?? [])
    .filter((day) => typeof day.date === "string")
    .map((day) => summarizeDay(day, window));

  const sources = {
    googleConnected:
      typeof schedule.sources?.googleConnected === "boolean" ? schedule.sources.googleConnected : null,
    notionReady: typeof schedule.sources?.notionReady === "boolean" ? schedule.sources.notionReady : null,
    reminderReady:
      typeof schedule.sources?.reminderReady === "boolean" ? schedule.sources.reminderReady : null,
  };

  // DaySpanは部分的な失敗をHTTP 200のまま errors に載せてくる。握りつぶすと
  // 「予定が無い日」として読まれるため、そのまま持ち上げる。
  const unavailable: DaySpanFailure[] = (schedule.errors ?? []).map((error) => ({
    source: text(error.source) ?? "dayspan",
    reason: text(error.reason) ?? "取得できなかった",
  }));

  const notes = [
    "DaySpanが統合済みの予定（Googleカレンダー）・タスクと日付リマインド（Notion）・移動をそのまま読んでいる。",
    `freeSlots は ${window.from}〜${window.to} の範囲で、時刻の決まった予定と移動のどちらとも重ならない時間帯（${MIN_FREE_MINUTES}分以上）。`,
  ];
  if (days.some((day) => day.allDayCount > 0)) {
    notes.push("終日の予定は時間帯を持たないため freeSlots を塞いでいない。");
  }
  if (sources.googleConnected === false) {
    notes.push("Googleカレンダーが未接続のため、events が空でも予定が無いという意味ではない。");
  }
  if (sources.notionReady === false || sources.reminderReady === false) {
    notes.push("NotionのDBが未設定のため、tasks・reminders が空でも項目が無いという意味ではない。");
  }
  if (unavailable.length > 0) {
    notes.push("unavailable にあるソースは取得できていないだけで、その日に項目が無いという意味ではない。");
  }

  const rangeFrom = text(schedule.range?.from);
  const rangeTo = text(schedule.range?.to);

  return {
    checkedAt: now.toISOString(),
    configured: true,
    complete: unavailable.length === 0,
    timezone: text(schedule.timeZone),
    generatedAt: text(schedule.generatedAt),
    range: rangeFrom && rangeTo ? { from: rangeFrom, to: rangeTo } : null,
    freeWindow: { from: window.from, to: window.to },
    sources,
    days,
    overdueTasks: (schedule.overdueTasks ?? []).map(summarizeOverdueTask),
    unavailable,
    note: notes.join(" "),
  };
}

/** 判定の材料が無いときの共通の形。 */
function blankSummary(
  now: Date,
  reason: string,
  note: string,
  window: TimeWindow,
  configured: boolean,
): ScheduleSummary {
  return {
    checkedAt: now.toISOString(),
    configured,
    complete: false,
    timezone: null,
    generatedAt: null,
    range: null,
    freeWindow: { from: window.from, to: window.to },
    sources: { googleConnected: null, notionReady: null, reminderReady: null },
    days: [],
    overdueTasks: [],
    unavailable: [{ source: "dayspan", reason }],
    note,
  };
}

export interface BuildScheduleOptions extends DaySpanScheduleQuery {
  /** 空き時間を数える時間帯。省略すると `DEFAULT_FREE_WINDOW`。 */
  freeWindow?: TimeWindow;
}

/** MCPツールから呼ばれる入口。設定を読み、取得し、畳む。 */
export async function buildSchedule(options: BuildScheduleOptions = {}): Promise<ScheduleSummary> {
  const now = new Date();
  const { freeWindow = DEFAULT_FREE_WINDOW, ...query } = options;
  const config = readDaySpanConfig();
  if (!config) {
    return blankSummary(
      now,
      "接続が設定されていない",
      "AIDE_DAYSPAN_TOKEN が設定されていないため、予定を取得できない。" +
        "設定するまでこのツールは何も答えられない（予定が無いという意味ではない）。",
      freeWindow,
      false,
    );
  }

  try {
    return summarizeSchedule(await fetchSchedule(config, query), now, freeWindow);
  } catch (cause) {
    // 取得できなかったこと自体が状態。例外にせず、理由を添えて返す。
    return blankSummary(
      now,
      describeFailure(cause),
      "DaySpanから予定を取得できなかった。予定が無いのではなく、予定が分からない。",
      freeWindow,
      true,
    );
  }
}
