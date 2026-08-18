import type { OpenMeteoDailyResponse, WeatherDay, WeatherForecast } from "./types.ts";

/**
 * Open-Meteo の応答を、日ごとの形へ畳む純粋関数。**テストはここに当てる。**
 *
 * ネットワークを触らないので、実際にAPIを叩かずに欠損・並びの検証ができる。
 */

/** 帰属表示の文言。Open-Meteo のデータは CC BY 4.0 で提供されている。 */
export const OPEN_METEO_ATTRIBUTION = "Weather data by Open-Meteo.com (CC BY 4.0)";

/**
 * WMO Weather interpretation code（0〜99）を短い日本語へ写す。
 *
 * Open-Meteo は天気を数値コードでしか返さない。**参照側（Claude・画面）ごとに訳語を
 * 決めると表現が揃わない**ため、Core側で1つに決めておく。
 * 語は「朝に予定を決める」用途に必要な粒度に留め、階級（弱・強）は括弧で添える。
 */
const WEATHER_CODE_TEXT = new Map<number, string>([
  [0, "快晴"],
  [1, "おおむね晴れ"],
  [2, "晴れ時々くもり"],
  [3, "くもり"],
  [45, "霧"],
  [48, "霧（霧氷）"],
  [51, "霧雨（弱）"],
  [53, "霧雨"],
  [55, "霧雨（強）"],
  [56, "着氷性の霧雨（弱）"],
  [57, "着氷性の霧雨（強）"],
  [61, "雨（弱）"],
  [63, "雨"],
  [65, "雨（強）"],
  [66, "着氷性の雨（弱）"],
  [67, "着氷性の雨（強）"],
  [71, "雪（弱）"],
  [73, "雪"],
  [75, "雪（強）"],
  [77, "霧雪"],
  [80, "にわか雨（弱）"],
  [81, "にわか雨"],
  [82, "にわか雨（激しい）"],
  [85, "にわか雪（弱）"],
  [86, "にわか雪（強）"],
  [95, "雷雨"],
  [96, "雷雨（ひょうをともなう）"],
  [99, "雷雨（激しいひょうをともなう）"],
]);

/**
 * 天気コードの日本語表記。
 *
 * 未知のコードでも表示が空にならないよう、コード番号をそのまま添えて返す。
 * WMOの表は将来増えうるため、「知らないコードが来たら落ちる」作りにしない。
 */
export function describeWeatherCode(code: number | null | undefined): string {
  if (code === null || code === undefined) return "不明";
  return WEATHER_CODE_TEXT.get(code) ?? `天気コード ${code}`;
}

/** 配列から添字の値を取り出す。長さが揃っていない応答でも null に落として続ける。 */
function at(values: (number | null)[] | undefined, index: number): number | null {
  const value = values?.[index];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 生の応答を `WeatherForecast` へ畳む。
 *
 * `daily.time` の並びを基準にする。他の配列は同じ長さで返る仕様だが、**それを前提に
 * 添字を数えず**、欠けていれば null にして日付だけは残す。予報が1日ぶんしか返らない
 * 場合でも「明日が無い」ことが参照側に伝わるほうが、例外で落とすより扱いやすい。
 */
export function parseForecast(raw: OpenMeteoDailyResponse): WeatherForecast {
  const dates = raw.daily?.time ?? [];

  const days: WeatherDay[] = dates.map((date, index) => {
    const weatherCode = at(raw.daily?.weather_code, index);
    return {
      date,
      weatherCode,
      summary: describeWeatherCode(weatherCode),
      temperatureMax: at(raw.daily?.temperature_2m_max, index),
      temperatureMin: at(raw.daily?.temperature_2m_min, index),
      precipitationProbabilityMax: at(raw.daily?.precipitation_probability_max, index),
    };
  });

  return {
    location: {
      // 応答には**実際に使われた観測格子の座標**が入る。要求値ではなくこちらを残すと、
      // 「どの地点の予報か」を後から確かめられる。
      latitude: raw.latitude,
      longitude: raw.longitude,
      timezone: raw.timezone,
    },
    days,
    attribution: OPEN_METEO_ATTRIBUTION,
  };
}
