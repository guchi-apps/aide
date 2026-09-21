import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { summarizeWeatherSection } from "./weather.ts";
import type { CachedValue } from "../cache/store.ts";
import type { WeatherDay, WeatherForecast } from "../connectors/weather/types.ts";

/**
 * 畳み込みは純粋関数（`summarizeWeatherSection`）に寄せてあるので、テストはここに集中させる。
 * 取得そのもの（Open-Meteo・キャッシュの読み書き）はコネクタ側・cache側のテストの担当。
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
