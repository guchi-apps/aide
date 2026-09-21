import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DaySpanDay, DaySpanSchedule } from "../connectors/dayspan/types.ts";
import {
  DEFAULT_FREE_WINDOW,
  MAX_DESCRIPTION_LENGTH,
  computeFreeSlots,
  mergeBusy,
  parseClock,
  summarizeDay,
  summarizeSchedule,
  truncateDescription,
  weekdayOf,
} from "./schedule.ts";

/**
 * 予定ビューの検査。
 *
 * **確かめたいのは畳み方であって、DaySpanの中身ではない。** 取得は
 * `src/core/connectors/dayspan/index.ts` に閉じてあり、ここに来るのは取得済みのレスポンス。
 * したがって純粋関数（`computeFreeSlots` / `summarizeDay` / `summarizeSchedule`）だけを
 * 直接呼ぶ。
 */

const NOW = new Date("2026-08-25T01:00:00.000Z");

function day(overrides: Partial<DaySpanDay> = {}): DaySpanDay {
  return { date: "2026-08-25", events: [], tasks: [], reminders: [], travels: [], ...overrides };
}

describe("parseClock / weekdayOf", () => {
  it("HH:MM を分へ直す", () => {
    assert.equal(parseClock("00:00"), 0);
    assert.equal(parseClock("09:30"), 570);
    assert.equal(parseClock("24:00"), 24 * 60);
  });

  it("読めない値は null にする", () => {
    for (const value of ["", "9:3", "0930", "25:00", "12:60", null, undefined]) {
      assert.equal(parseClock(value as string | null | undefined), null, `${String(value)} が通った`);
    }
  });

  it("曜日は暦日から決まる（2026-08-25 は火曜）", () => {
    assert.equal(weekdayOf("2026-08-25"), "火");
    assert.equal(weekdayOf("2026-08-30"), "日");
  });
});

describe("mergeBusy", () => {
  it("重なりと隣接を1つに畳む", () => {
    const merged = mergeBusy(
      [
        { start: 600, end: 660 },
        { start: 630, end: 700 },
        { start: 700, end: 720 },
      ],
      { start: 480, end: 1320 },
    );
    assert.deepEqual(merged, [{ start: 600, end: 720 }]);
  });

  it("窓の外へはみ出した分は切り落とす", () => {
    const merged = mergeBusy([{ start: 300, end: 1400 }], { start: 480, end: 1320 });
    assert.deepEqual(merged, [{ start: 480, end: 1320 }]);
  });

  it("日付をまたぐ予定（終了が開始より前）は窓の終わりまでとして扱う", () => {
    // 23:00〜01:00 のような予定。翌日へ持ち越すとDaySpanの日ごとの振り分けと食い違う。
    const merged = mergeBusy([{ start: 1380, end: 60 }], { start: 480, end: 1320 });
    assert.deepEqual(merged, []);
    const inside = mergeBusy([{ start: 1200, end: 60 }], { start: 480, end: 1320 });
    assert.deepEqual(inside, [{ start: 1200, end: 1320 }]);
  });
});

describe("computeFreeSlots", () => {
  it("予定の前後と間を空きとして返す", () => {
    const { freeSlots, busyMinutes } = computeFreeSlots([
      { startTime: "10:00", endTime: "11:00" },
      { startTime: "14:00", endTime: "15:30" },
    ]);

    assert.deepEqual(freeSlots, [
      { from: "08:00", to: "10:00", minutes: 120 },
      { from: "11:00", to: "14:00", minutes: 180 },
      { from: "15:30", to: "22:00", minutes: 390 },
    ]);
    assert.equal(busyMinutes, 150);
  });

  it("何も無ければ窓が丸ごと空く", () => {
    const { freeSlots, busyMinutes } = computeFreeSlots([]);
    assert.deepEqual(freeSlots, [{ from: "08:00", to: "22:00", minutes: 840 }]);
    assert.equal(busyMinutes, 0);
  });

  it("30分未満の隙間は空きとして数えない", () => {
    const { freeSlots } = computeFreeSlots([
      { startTime: "08:00", endTime: "12:00" },
      { startTime: "12:20", endTime: "22:00" },
    ]);
    assert.deepEqual(freeSlots, []);
  });

  it("時刻の片方でも欠けているものは塞がない", () => {
    // 終了時刻だけ欠けたものへ既定の長さを当てると、空いている時間を埋まっていると報告する。
    const { freeSlots, busyMinutes } = computeFreeSlots([
      { startTime: "10:00", endTime: null },
      { startTime: null, endTime: null },
    ]);
    assert.deepEqual(freeSlots, [{ from: "08:00", to: "22:00", minutes: 840 }]);
    assert.equal(busyMinutes, 0);
  });

  it("窓は指定で変えられる", () => {
    const { freeSlots } = computeFreeSlots([{ startTime: "10:00", endTime: "11:00" }], {
      from: "09:00",
      to: "12:00",
    });
    assert.deepEqual(freeSlots, [
      { from: "09:00", to: "10:00", minutes: 60 },
      { from: "11:00", to: "12:00", minutes: 60 },
    ]);
  });

  it("前後が逆の窓では空きを返さない", () => {
    assert.deepEqual(computeFreeSlots([], { from: "22:00", to: "08:00" }), {
      freeSlots: [],
      busyMinutes: 0,
    });
  });
});

describe("truncateDescription", () => {
  it("上限以内ならそのまま返し、前後の空白は落とす", () => {
    assert.equal(truncateDescription("  メモ\n"), "メモ");
    const exact = "あ".repeat(MAX_DESCRIPTION_LENGTH);
    assert.equal(truncateDescription(exact), exact);
  });

  it("上限を超えたら切って末尾に … を付ける", () => {
    const cut = truncateDescription("あ".repeat(MAX_DESCRIPTION_LENGTH + 50));
    assert.equal(cut, `${"あ".repeat(MAX_DESCRIPTION_LENGTH)}…`);
  });

  it("絵文字（サロゲートペア）を途中で割らない", () => {
    const cut = truncateDescription("😀".repeat(5), 3);
    assert.equal(cut, "😀😀😀…");
  });

  it("空・空白だけ・欠けは null", () => {
    for (const value of ["", "   \n", null, undefined]) {
      assert.equal(truncateDescription(value), null, `${JSON.stringify(value)} が通った`);
    }
  });
});

describe("summarizeDay", () => {
  it("終日の予定は空き時間を塞がない", () => {
    const summarized = summarizeDay(
      day({
        events: [
          { id: "a", title: "夏季休暇", allDay: true, start: "2026-08-25" },
          { id: "b", title: "定例会", startTime: "10:00", endTime: "11:00" },
        ],
      }),
    );

    assert.equal(summarized.allDayCount, 1);
    assert.equal(summarized.busyMinutes, 60);
    assert.deepEqual(summarized.freeSlots, [
      { from: "08:00", to: "10:00", minutes: 120 },
      { from: "11:00", to: "22:00", minutes: 660 },
    ]);
  });

  it("移動も予定と同じように時間を塞ぐ", () => {
    const summarized = summarizeDay(
      day({
        events: [{ id: "a", title: "打ち合わせ", startTime: "13:00", endTime: "14:00" }],
        travels: [
          { id: "t", title: "自宅 → 渋谷", startTime: "12:00", endTime: "13:00", estimated: true },
        ],
      }),
    );

    assert.equal(summarized.busyMinutes, 120);
    assert.deepEqual(summarized.freeSlots, [
      { from: "08:00", to: "12:00", minutes: 240 },
      { from: "14:00", to: "22:00", minutes: 480 },
    ]);
    assert.equal(summarized.travels[0]?.estimated, true);
  });

  it("中止・不参加の予定は残したまま outcome を載せ、空き時間は塞がない", () => {
    const summarized = summarizeDay(
      day({
        events: [
          { id: "a", title: "定例会", startTime: "10:00", endTime: "11:00", outcome: "CANCELED" },
          { id: "b", title: "歯医者", startTime: "13:00", endTime: "14:00", outcome: "ABSENT" },
          { id: "c", title: "面談", startTime: "15:00", endTime: "16:00", outcome: null },
        ],
      }),
    );

    // 一覧から消さない。消すと呼び出し側では「その予定は無かった」ことになる。
    assert.deepEqual(
      summarized.events.map((event) => event.outcome),
      ["CANCELED", "ABSENT", null],
    );
    // 塞ぐのは通常どおり行われる面談だけ。
    assert.equal(summarized.busyMinutes, 60);
    assert.deepEqual(summarized.freeSlots, [
      { from: "08:00", to: "15:00", minutes: 420 },
      { from: "16:00", to: "22:00", minutes: 360 },
    ]);
  });

  it("将来増えた outcome の種類も、起こらない予定として空きを塞がない", () => {
    const summarized = summarizeDay(
      day({ events: [{ id: "a", startTime: "10:00", endTime: "11:00", outcome: "POSTPONED" }] }),
    );

    assert.equal(summarized.events[0]?.outcome, "POSTPONED");
    assert.equal(summarized.busyMinutes, 0);
  });

  it("outcome が無い・空の予定は null になり、空きを塞ぐ", () => {
    const summarized = summarizeDay(
      day({
        events: [
          { id: "a", startTime: "10:00", endTime: "11:00" },
          { id: "b", startTime: "12:00", endTime: "13:00", outcome: "" },
        ],
      }),
    );

    assert.deepEqual(
      summarized.events.map((event) => event.outcome),
      [null, null],
    );
    assert.equal(summarized.busyMinutes, 120);
  });

  it("予定の本文を載せる。無ければ null", () => {
    const summarized = summarizeDay(
      day({
        events: [
          { id: "a", title: "定例会", description: "議題: 来期の予算" },
          { id: "b", title: "面談", description: null },
          { id: "c", title: "会食" },
        ],
      }),
    );

    assert.deepEqual(
      summarized.events.map((event) => event.description),
      ["議題: 来期の予算", null, null],
    );
  });

  it("欠けたフィールドがあっても落ちず、既定の見出しを当てる", () => {
    const summarized = summarizeDay(
      day({
        events: [{ id: "a" }],
        tasks: [{ id: "t" }],
        reminders: [{ id: "r" }],
      }),
    );

    assert.equal(summarized.events[0]?.title, "（無題の予定）");
    assert.equal(summarized.events[0]?.allDay, false);
    assert.equal(summarized.tasks[0]?.kind, "due");
    assert.deepEqual(summarized.tasks[0]?.tags, []);
    assert.equal(summarized.reminders[0]?.kind, "reminder");
    assert.equal(summarized.reminders[0]?.annual, null);
  });
});

describe("summarizeSchedule", () => {
  const base: DaySpanSchedule = {
    generatedAt: "2026-08-25T00:59:00.000Z",
    timeZone: "Asia/Tokyo",
    range: { from: "2026-08-25", to: "2026-08-25" },
    sources: { googleConnected: true, notionReady: true, reminderReady: true },
    days: [day()],
  };

  it("取れていれば complete になる", () => {
    const summary = summarizeSchedule(base, NOW);
    assert.equal(summary.configured, true);
    assert.equal(summary.complete, true);
    assert.equal(summary.timezone, "Asia/Tokyo");
    assert.deepEqual(summary.range, { from: "2026-08-25", to: "2026-08-25" });
    assert.deepEqual(summary.freeWindow, { ...DEFAULT_FREE_WINDOW });
    assert.equal(summary.days.length, 1);
    assert.deepEqual(summary.unavailable, []);
  });

  it("中止・不参加の予定があるときだけ、note にその読み方を添える", () => {
    const withOutcome = summarizeSchedule(
      {
        ...base,
        days: [day({ events: [{ id: "a", startTime: "10:00", endTime: "11:00", outcome: "CANCELED" }] })],
      },
      NOW,
    );
    assert.match(withOutcome.note, /CANCELED/);
    assert.match(withOutcome.note, /数えていない/);

    assert.doesNotMatch(summarizeSchedule(base, NOW).note, /CANCELED/);
  });

  it("部分的な失敗（errors）は握りつぶさず持ち上げる", () => {
    const summary = summarizeSchedule(
      { ...base, errors: [{ source: "notion", reason: "取得できませんでした。" }] },
      NOW,
    );

    assert.equal(summary.complete, false);
    assert.deepEqual(summary.unavailable, [{ source: "notion", reason: "取得できませんでした。" }]);
    assert.match(summary.note, /取得できていないだけ/);
  });

  it("Google未接続は「予定が無い」と読ませない", () => {
    const summary = summarizeSchedule(
      { ...base, sources: { googleConnected: false, notionReady: true, reminderReady: true } },
      NOW,
    );

    // 未接続そのものは DaySpan 側で失敗扱いにならないため complete は true のまま。
    // 中身が空である理由は note と sources から読み取らせる。
    assert.equal(summary.complete, true);
    assert.equal(summary.sources.googleConnected, false);
    assert.match(summary.note, /Googleカレンダーが未接続/);
  });

  it("日付を持たない要素は落とす", () => {
    const summary = summarizeSchedule(
      { ...base, days: [day(), { events: [] } as unknown as DaySpanDay] },
      NOW,
    );
    assert.equal(summary.days.length, 1);
  });
});
