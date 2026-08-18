import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { forecastUrl, readWeatherConfig } from "./index.ts";
import { describeWeatherCode, OPEN_METEO_ATTRIBUTION, parseForecast } from "./parse.ts";
import type { OpenMeteoDailyResponse } from "./types.ts";

/** 実際の応答（2日ぶん）と同じ形。 */
const RESPONSE: OpenMeteoDailyResponse = {
  latitude: 34.8,
  longitude: 135.5625,
  timezone: "Asia/Tokyo",
  daily: {
    time: ["2026-08-19", "2026-08-20"],
    weather_code: [51, 95],
    temperature_2m_max: [31.5, 32.8],
    temperature_2m_min: [24.0, 24.6],
    precipitation_probability_max: [24, 63],
  },
};

/** 環境変数を一時的に差し替える。テスト間で残さない。 */
function withEnv(values: Record<string, string | undefined>, run: () => void): void {
  const saved = Object.keys(values).map((key) => [key, process.env[key]] as const);
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("天気予報の正規化", () => {
  it("日ごとの配列を1日ずつの形へ畳む", () => {
    const forecast = parseForecast(RESPONSE);

    assert.equal(forecast.days.length, 2);
    assert.deepEqual(forecast.days[0], {
      date: "2026-08-19",
      weatherCode: 51,
      summary: "霧雨（弱）",
      temperatureMax: 31.5,
      temperatureMin: 24.0,
      precipitationProbabilityMax: 24,
    });
    // 並びは応答のまま（先頭が今日）。
    assert.equal(forecast.days[1]?.date, "2026-08-20");
    assert.equal(forecast.days[1]?.summary, "雷雨");
  });

  it("実際に使われた格子の座標とタイムゾーンを残す", () => {
    const forecast = parseForecast(RESPONSE);
    assert.deepEqual(forecast.location, {
      latitude: 34.8,
      longitude: 135.5625,
      timezone: "Asia/Tokyo",
    });
  });

  it("帰属表示をデータへ同梱する", () => {
    assert.equal(parseForecast(RESPONSE).attribution, OPEN_METEO_ATTRIBUTION);
    assert.match(OPEN_METEO_ATTRIBUTION, /Open-Meteo/);
    assert.match(OPEN_METEO_ATTRIBUTION, /CC BY 4\.0/);
  });

  it("値が欠けている日は null にして日付だけ残す", () => {
    const forecast = parseForecast({
      ...RESPONSE,
      daily: {
        time: ["2026-08-19", "2026-08-20"],
        // 2日目ぶんが揃っていない応答（配列が短い・null が混ざる）。
        weather_code: [3],
        temperature_2m_max: [31.5, null],
        temperature_2m_min: [],
        precipitation_probability_max: undefined,
      },
    });

    assert.equal(forecast.days.length, 2);
    assert.equal(forecast.days[0]?.summary, "くもり");
    assert.equal(forecast.days[0]?.temperatureMin, null);
    assert.deepEqual(forecast.days[1], {
      date: "2026-08-20",
      weatherCode: null,
      summary: "不明",
      temperatureMax: null,
      temperatureMin: null,
      precipitationProbabilityMax: null,
    });
  });

  it("daily 自体が無くても例外にせず空で返す（判断は呼び出し側）", () => {
    const forecast = parseForecast({ latitude: 34.8, longitude: 135.56, timezone: "Asia/Tokyo" });
    assert.deepEqual(forecast.days, []);
  });
});

describe("天気コードの日本語表記", () => {
  it("主要なコードを短い語へ写す", () => {
    assert.equal(describeWeatherCode(0), "快晴");
    assert.equal(describeWeatherCode(3), "くもり");
    assert.equal(describeWeatherCode(65), "雨（強）");
    assert.equal(describeWeatherCode(75), "雪（強）");
  });

  it("知らないコードでも空にならない", () => {
    assert.equal(describeWeatherCode(42), "天気コード 42");
    assert.equal(describeWeatherCode(null), "不明");
  });
});

describe("地点の設定", () => {
  it("未設定なら既定の地点を使う", () => {
    withEnv({ AIDE_WEATHER_LAT: undefined, AIDE_WEATHER_LON: undefined }, () => {
      assert.deepEqual(readWeatherConfig(), { latitude: 34.82, longitude: 135.56 });
    });
  });

  it("環境変数で地点を差し替えられる", () => {
    withEnv({ AIDE_WEATHER_LAT: "43.06", AIDE_WEATHER_LON: "141.35" }, () => {
      assert.deepEqual(readWeatherConfig(), { latitude: 43.06, longitude: 141.35 });
    });
  });

  it("座標として不正な値は既定へ落とさず失敗させる", () => {
    withEnv({ AIDE_WEATHER_LAT: "きた", AIDE_WEATHER_LON: undefined }, () => {
      assert.throws(() => readWeatherConfig(), /AIDE_WEATHER_LAT/);
    });
    withEnv({ AIDE_WEATHER_LAT: undefined, AIDE_WEATHER_LON: "999" }, () => {
      assert.throws(() => readWeatherConfig(), /AIDE_WEATHER_LON/);
    });
  });
});

describe("問い合わせURL", () => {
  it("日ごとの項目・日本時間・2日ぶんを要求する", () => {
    const url = new URL(forecastUrl({ latitude: 34.82, longitude: 135.56 }));

    assert.equal(url.origin + url.pathname, "https://api.open-meteo.com/v1/forecast");
    assert.equal(url.searchParams.get("latitude"), "34.82");
    assert.equal(url.searchParams.get("longitude"), "135.56");
    assert.equal(url.searchParams.get("timezone"), "Asia/Tokyo");
    assert.equal(url.searchParams.get("forecast_days"), "2");
    assert.equal(
      url.searchParams.get("daily"),
      "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    );
    // 時間別は要求しない（量が増えるだけで朝の判断には使わない）。
    assert.equal(url.searchParams.get("hourly"), null);
  });
});
