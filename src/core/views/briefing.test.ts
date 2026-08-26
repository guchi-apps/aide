import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assembleBriefing, summarizeScheduleSection, summarizeWeatherSection } from "./briefing.ts";
import type { BriefingSection, BriefingWeather, PendingSection } from "./briefing.ts";
import type { CachedValue } from "../cache/store.ts";
import type { WeatherDay, WeatherForecast } from "../connectors/weather/types.ts";
import type { ScheduleSummary } from "./schedule.ts";

/**
 * 畳み込みは純粋関数（`summarizeWeatherSection` / `assembleBriefing`）に寄せてあるので、
 * テストはここに集中させる。取得そのもの（Open-Meteo・キャッシュの読み書き）は
 * コネクタ側・cache側のテストの担当。
 */

const TODAY = "2026-08-19";
const TOMORROW = "2026-08-20";

function day(date: string, overrides: Partial<WeatherDay> = {}): WeatherDay {
  return {
    date,
    weatherCode: 3,
    summary: "くもり",
    temperatureMax: 33.1,
    temperatureMin: 25.4,
    precipitationProbabilityMax: 20,
    ...overrides,
  };
}

function cached(
  days: WeatherDay[],
  ageMinutes = 12,
): CachedValue<WeatherForecast> {
  return {
    source: "open-meteo",
    fetchedAt: "2026-08-19T06:00:00.000Z",
    ageMinutes,
    data: {
      location: { latitude: 34.82, longitude: 135.56, timezone: "Asia/Tokyo" },
      days,
      attribution: "Weather data by Open-Meteo.com (CC BY 4.0)",
    },
  };
}

describe("summarizeWeatherSection", () => {
  it("対象日と翌日の予報を返す", () => {
    const section = summarizeWeatherSection(cached([day(TODAY), day(TOMORROW)]), TODAY);

    assert.equal(section.state, "ok");
    assert.equal(section.stale, false);
    assert.equal(section.reason, null);
    assert.equal(section.fetchedAt, "2026-08-19T06:00:00.000Z");
    assert.equal(section.ageMinutes, 12);
    assert.equal(section.data?.today?.date, TODAY);
    assert.equal(section.data?.tomorrow?.date, TOMORROW);
    // 帰属表示はデータと一緒に持ち回る（CC BY 4.0 の条件）。
    assert.match(section.data?.attribution ?? "", /Open-Meteo/);
  });

  it("配列の先頭ではなく日付で今日を選ぶ", () => {
    // 日付をまたいだ直後のキャッシュ。先頭は昨日ぶんになっている。
    const section = summarizeWeatherSection(cached([day("2026-08-18"), day(TODAY)]), TODAY);

    assert.equal(section.state, "ok");
    assert.equal(section.data?.today?.date, TODAY);
    // 翌日ぶんは含まれていないので null。今日だけは答えられる。
    assert.equal(section.data?.tomorrow, null);
  });

  it("対象日が含まれていなければ取得できていない扱いにする", () => {
    const section = summarizeWeatherSection(cached([day("2026-08-17"), day("2026-08-18")]), TODAY);

    assert.equal(section.state, "unavailable");
    assert.equal(section.stale, true);
    assert.equal(section.data, null);
    assert.match(section.reason ?? "", /2026-08-19/);
    // いつ取ったものかは分かるので、時刻は落とさずに返す。
    assert.equal(section.ageMinutes, 12);
  });

  it("鮮度切れでも中身は返す", () => {
    const section = summarizeWeatherSection(cached([day(TODAY)], 200), TODAY);

    assert.equal(section.state, "ok");
    assert.equal(section.stale, true);
    assert.equal(section.data?.today?.date, TODAY);
  });

  it("一度も取得していなければ理由を添えて返す", () => {
    const section = summarizeWeatherSection(null, TODAY);

    assert.equal(section.state, "unavailable");
    assert.equal(section.stale, true);
    assert.equal(section.data, null);
    assert.match(section.reason ?? "", /weather-sync/);
  });
});

const NOW = new Date("2026-08-19T00:00:00.000Z");

function scheduleSummary(overrides: Partial<ScheduleSummary> = {}): ScheduleSummary {
  return {
    checkedAt: NOW.toISOString(),
    configured: true,
    complete: true,
    timezone: "Asia/Tokyo",
    generatedAt: "2026-08-18T23:58:00.000Z",
    range: { from: TODAY, to: TODAY },
    freeWindow: { from: "08:00", to: "22:00" },
    sources: { googleConnected: true, notionReady: true, reminderReady: true },
    days: [
      {
        date: TODAY,
        weekday: "水",
        events: [],
        travels: [],
        tasks: [],
        reminders: [],
        freeSlots: [{ from: "08:00", to: "22:00", minutes: 840 }],
        busyMinutes: 0,
        allDayCount: 0,
      },
    ],
    overdueTasks: [],
    unavailable: [],
    note: "",
    ...overrides,
  };
}

describe("summarizeScheduleSection", () => {
  it("対象日ぶんを ok として返す", () => {
    const section = summarizeScheduleSection(scheduleSummary(), TODAY, NOW);

    assert.equal(section.state, "ok");
    assert.equal(section.reason, null);
    assert.equal(section.data?.date, TODAY);
    assert.equal(section.fetchedAt, "2026-08-18T23:58:00.000Z");
    assert.equal(section.ageMinutes, 2);
    // 都度取得なので「取得が止まっている」状態が起きない。
    assert.equal(section.stale, false);
  });

  it("未設定は not_configured にする（unavailable と区別する）", () => {
    const section = summarizeScheduleSection(
      scheduleSummary({
        configured: false,
        complete: false,
        generatedAt: null,
        days: [],
        unavailable: [{ source: "dayspan", reason: "接続が設定されていない" }],
      }),
      TODAY,
      NOW,
    );

    assert.equal(section.state, "not_configured");
    assert.equal(section.data, null);
    assert.match(section.reason ?? "", /設定されていない/);
  });

  it("対象日が含まれていなければ unavailable にする", () => {
    const section = summarizeScheduleSection(scheduleSummary(), TOMORROW, NOW);

    assert.equal(section.state, "unavailable");
    assert.equal(section.data, null);
    assert.match(section.reason ?? "", new RegExp(TOMORROW));
  });

  it("部分的な失敗でも取れたぶんは返す", () => {
    const section = summarizeScheduleSection(
      scheduleSummary({
        complete: false,
        unavailable: [{ source: "notion", reason: "取得できませんでした。" }],
      }),
      TODAY,
      NOW,
    );

    // 中身はあるが ok にはしない。天気だけの答えへ落とさないために data は残す。
    assert.equal(section.state, "unavailable");
    assert.equal(section.data?.date, TODAY);
    assert.match(section.reason ?? "", /取得できませんでした/);
  });
});


function pending(reason: string): PendingSection {
  return { state: "not_connected", fetchedAt: null, ageMinutes: null, stale: false, reason, data: null };
}

function okWeather(): BriefingSection<BriefingWeather> {
  return summarizeWeatherSection(cached([day(TODAY), day(TOMORROW)]), TODAY);
}

describe("assembleBriefing", () => {
  it("全ソースが揃えば complete になる", () => {
    const briefing = assembleBriefing(NOW, TODAY, {
      schedule: { ...pending(""), state: "ok", reason: null },
      transit: { ...pending(""), state: "ok", reason: null },
      weather: okWeather(),
    });

    assert.equal(briefing.date, TODAY);
    assert.equal(briefing.timezone, "Asia/Tokyo");
    assert.equal(briefing.complete, true);
    assert.deepEqual(briefing.unavailable, []);
  });

  it("取れなかったソースだけが unavailable に入り、全体は失敗しない", () => {
    const briefing = assembleBriefing(NOW, TODAY, {
      schedule: pending("予定のコネクタが未実装"),
      transit: pending("交通のコネクタが未実装"),
      weather: okWeather(),
    });

    assert.equal(briefing.complete, false);
    assert.deepEqual(briefing.unavailable, [
      { source: "dayspan", reason: "予定のコネクタが未実装" },
      { source: "trainroute", reason: "交通のコネクタが未実装" },
    ]);
    // 天気は取れているので、そこだけは答えられる。
    assert.equal(briefing.weather.state, "ok");
    assert.equal(briefing.weather.data?.today?.date, TODAY);
  });

  it("明日ぶんが未取得なら断り書きを添える（深夜0時台に毎日起きる）", () => {
    // 日付が変わってから次の毎時同期までは、キャッシュの中身が「前日・当日」のままになる。
    // このときキャッシュ自体は新しいので stale にはならない。
    const weather = summarizeWeatherSection(cached([day("2026-08-18"), day(TODAY)]), TODAY);
    const briefing = assembleBriefing(NOW, TODAY, {
      schedule: pending("予定のコネクタが未実装"),
      transit: pending("交通のコネクタが未実装"),
      weather,
    });

    assert.equal(briefing.weather.state, "ok");
    assert.equal(briefing.weather.stale, false);
    assert.equal(briefing.weather.data?.tomorrow, null);
    assert.match(briefing.note, /明日ぶんの予報/);
  });

  it("欠けたソースがあるときは読み違いを防ぐ断り書きを添える", () => {
    const briefing = assembleBriefing(NOW, TODAY, {
      schedule: pending("予定のコネクタが未実装"),
      transit: pending("交通のコネクタが未実装"),
      weather: summarizeWeatherSection(null, TODAY),
    });

    assert.match(briefing.note, /無いという意味ではない/);
    assert.match(briefing.note, /not_connected/);
    assert.equal(briefing.unavailable.length, 3);
  });
});
