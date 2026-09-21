import {
  describeFailure,
  fetchSchedule,
  readDaySpanConfig,
} from "../connectors/dayspan/index.ts";
import type { DaySpanFailure, DaySpanReminder, DaySpanSchedule } from "../connectors/dayspan/types.ts";

/** DaySpanが一度に返せる上限。myroomは60日先まで書き出すが、問い合わせはこの範囲に限られる。 */
export const GARBAGE_LOOKAHEAD_DAYS = 31;

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

export interface GarbageCollection {
  /** myroomで設定された収集区分名。 */
  category: string;
  /** `YYYY-MM-DD`。 */
  date: string;
  weekday: string;
  /** myroomで設定された注意事項。無ければ null。 */
  note: string | null;
}

export interface GarbageSummary {
  checkedAt: string;
  /** AIDEからDaySpanへ接続する設定があるか。 */
  configured: boolean;
  /** 取得できなかったソースが無いか。false は「収集なし」を意味しない。 */
  complete: boolean;
  timezone: string | null;
  generatedAt: string | null;
  /** DaySpanが実際に検索した範囲。 */
  range: { from: string; to: string } | null;
  /** 検索の起点日。DaySpanが返さなければ null。 */
  date: string | null;
  /** 区分で絞り込んだ場合の値。 */
  category: string | null;
  /** `date` 当日に出せる収集区分。 */
  collectionsOnDate: GarbageCollection[];
  /** 各収集区分の、検索範囲で最初に来る収集日。 */
  nextCollections: GarbageCollection[];
  unavailable: DaySpanFailure[];
  note: string;
}

function text(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed === "" ? null : trimmed;
}

function weekdayOf(date: string): string {
  const at = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(at.getTime()) ? "?" : (WEEKDAYS[at.getUTCDay()] ?? "?");
}

function collectionFrom(date: string, reminder: DaySpanReminder): GarbageCollection | null {
  const category = text(reminder.title);
  if (!category) return null;
  return { category, date, weekday: weekdayOf(date), note: text(reminder.memo) };
}

/** DaySpanのレスポンスから、myroomが書き出したゴミ収集日だけを取り出す。 */
export function collectGarbage(schedule: DaySpanSchedule, category: string | null = null): GarbageCollection[] {
  const collections = (schedule.days ?? []).flatMap((day) => {
    if (typeof day.date !== "string") return [];
    return (day.reminders ?? [])
      .filter((reminder) => reminder.source === "garbage")
      .map((reminder) => collectionFrom(day.date, reminder))
      .filter((collection): collection is GarbageCollection => collection !== null);
  });

  return collections
    .filter((collection) => category === null || collection.category === category)
    .sort((left, right) => left.date.localeCompare(right.date) || left.category.localeCompare(right.category));
}

/** 取得済みのDaySpanレスポンスを、収集日の問いに必要な粒度へ畳む。 */
export function summarizeGarbage(
  schedule: DaySpanSchedule,
  now: Date,
  category: string | null = null,
): GarbageSummary {
  const normalizedCategory = text(category);
  const collections = collectGarbage(schedule, normalizedCategory);
  const rangeFrom = text(schedule.range?.from);
  const rangeTo = text(schedule.range?.to);
  const unavailable: DaySpanFailure[] = (schedule.errors ?? []).map((error) => ({
    source: text(error.source) ?? "dayspan",
    reason: text(error.reason) ?? "取得できなかった",
  }));
  const collectionsOnDate = rangeFrom ? collections.filter((collection) => collection.date === rangeFrom) : [];
  const seenCategories = new Set<string>();
  const nextCollections = collections.filter((collection) => {
    if (seenCategories.has(collection.category)) return false;
    seenCategories.add(collection.category);
    return true;
  });

  const notes = [
    "myroomが正として書き出し、DaySpanが統合したゴミ収集日だけを読んでいる。AIDEから収集日の変更はできない。",
    `nextCollections は検索範囲内（最大${GARBAGE_LOOKAHEAD_DAYS}日）の最初の収集日で、範囲外の次回日は断定しない。`,
  ];
  if (unavailable.length > 0) {
    notes.push("unavailable にあるソースは取得できていないため、収集が無いという意味ではない。");
  }
  if (collections.length === 0) {
    notes.push(
      normalizedCategory
        ? "指定区分の収集日は検索範囲に無いか、ゴミ収集日データがDaySpanへ設定・同期されていない。"
        : "ゴミ収集日は検索範囲に無いか、ゴミ収集日データがDaySpanへ設定・同期されていない。",
    );
  }

  return {
    checkedAt: now.toISOString(),
    configured: true,
    complete: unavailable.length === 0,
    timezone: text(schedule.timeZone),
    generatedAt: text(schedule.generatedAt),
    range: rangeFrom && rangeTo ? { from: rangeFrom, to: rangeTo } : null,
    date: rangeFrom,
    category: normalizedCategory,
    collectionsOnDate,
    nextCollections,
    unavailable,
    note: notes.join(" "),
  };
}

function blankGarbageSummary(now: Date, reason: string, note: string, configured: boolean): GarbageSummary {
  return {
    checkedAt: now.toISOString(),
    configured,
    complete: false,
    timezone: null,
    generatedAt: null,
    range: null,
    date: null,
    category: null,
    collectionsOnDate: [],
    nextCollections: [],
    unavailable: [{ source: "dayspan", reason }],
    note,
  };
}

/** MCPツールから呼ばれる入口。DaySpanの既存の読み取り経路だけを使う。 */
export async function buildGarbage(
  options: { date?: string; category?: string | null } = {},
): Promise<GarbageSummary> {
  const now = new Date();
  const category = text(options.category);
  const config = readDaySpanConfig();
  if (!config) {
    const summary = blankGarbageSummary(
      now,
      "接続が設定されていない",
      "AIDE_DAYSPAN_TOKEN が設定されていないため、ゴミ収集日を取得できない。収集が無いという意味ではない。",
      false,
    );
    return { ...summary, category };
  }

  try {
    return summarizeGarbage(
      await fetchSchedule(config, { date: options.date, days: GARBAGE_LOOKAHEAD_DAYS, overdueDays: 0 }),
      now,
      category,
    );
  } catch (cause) {
    const summary = blankGarbageSummary(
      now,
      describeFailure(cause),
      "DaySpanからゴミ収集日を取得できなかった。収集が無いのではなく、収集日が分からない。",
      true,
    );
    return { ...summary, category };
  }
}
