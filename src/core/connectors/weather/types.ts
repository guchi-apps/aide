/**
 * 天気予報（Open-Meteo）の型。
 *
 * 生の応答（`OpenMeteoDailyResponse`）と、AIDEが持ち回る正規化後の形（`WeatherForecast`）を
 * 分けている。向こうは指定したパラメータ名がそのままキーになり、値は**日ごとの配列**で返るため、
 * その形のまま横断ビューへ渡すと参照側が添字を数えることになる。
 */

/**
 * Open-Meteo の `GET /v1/forecast` のうち、**AIDEが要求したフィールドだけ**を宣言する。
 *
 * `daily` の各配列は `daily.time` と同じ長さ・同じ並びで返る。
 * 値が取れない日は `null` が入りうるため、数値ではなく `number | null` で受ける。
 */
export interface OpenMeteoDailyResponse {
  latitude: number;
  longitude: number;
  timezone: string;
  daily?: {
    /** `YYYY-MM-DD`。`timezone` で指定したタイムゾーンでの日付。 */
    time?: string[];
    weather_code?: (number | null)[];
    temperature_2m_max?: (number | null)[];
    temperature_2m_min?: (number | null)[];
    precipitation_probability_max?: (number | null)[];
  };
}

/** 1日ぶんの予報。朝に知りたいものだけに絞ってある。 */
export interface WeatherDay {
  /** `YYYY-MM-DD`（日本時間）。 */
  date: string;
  /** WMOの天気コード。数値のまま持つ（アイコンの割り当ては表示側の判断）。 */
  weatherCode: number | null;
  /** 天気コードを短い日本語へ写したもの。未知のコードでも必ず何か入る。 */
  summary: string;
  /** 最高気温（℃）。取れなければ null。 */
  temperatureMax: number | null;
  /** 最低気温（℃）。取れなければ null。 */
  temperatureMin: number | null;
  /** その日の降水確率の最大（%）。取れなければ null。 */
  precipitationProbabilityMax: number | null;
}

export interface WeatherLocation {
  latitude: number;
  longitude: number;
  /** 日付の区切りに使ったタイムゾーン。日本時間で切っていることの根拠。 */
  timezone: string;
}

export interface WeatherForecast {
  location: WeatherLocation;
  /** 今日から順に並ぶ（既定は今日・明日の2日）。 */
  days: WeatherDay[];
  /**
   * CC BY 4.0 の帰属表示。
   *
   * Open-Meteo の無料利用は帰属表示が条件なので、**データと一緒に持ち回る**。
   * 表示する側が文言を自前で書くと、経路が増えたときに書き忘れが起きる。
   */
  attribution: string;
}
