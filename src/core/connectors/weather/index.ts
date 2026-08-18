import { parseForecast } from "./parse.ts";
import type { OpenMeteoDailyResponse, WeatherForecast } from "./types.ts";

/**
 * 天気予報コネクタ（Open-Meteo）。
 *
 * 朝のブリーフィング（guchi-apps/question#7）の材料。**Open-Meteo を直接叩く。**
 *
 * - **APIキーが要らない**ので、AIDEに新しい認証経路が増えない
 * - `fetch` だけで書けるので実行時依存ゼロを保てる
 * - myroom・portfolio が既に Open-Meteo を使っており、取得元が揃う
 *
 * myroom 経由で受け取る案は採らなかった。あの形（ops-dashboard・subscription-lists）を選ぶ
 * 動機は「認証情報を1か所へ閉じる」か「スケジューラを集約する」かのどちらかで、
 * 天気はAPIキーも巡回も持たないためどちらにも当たらず、依存が増えるだけになる。
 *
 * **利用条件（無料枠）**: 非商用に限る／1日10,000回未満／CC BY 4.0 の帰属表示。
 * 個人利用なので前2つは満たす。帰属表示は `WeatherForecast.attribution` に載せ、
 * 機能一覧ページ（`/features`）にも出している。
 */

const ENDPOINT = "https://api.open-meteo.com/v1/forecast";

/**
 * 1本あたりの制限時間。
 * worker から呼ぶので固まっても他のリクエストは巻き込まないが、systemd の
 * `TimeoutStartSec` に達する前に自分で終わらせて、失敗として記録・通知させる。
 */
const TIMEOUT_MS = 8_000;

/** 日付の区切り。**指定しないとUTCで切られ、日本時間の朝に「今日」が前日になる。** */
const TIMEZONE = "Asia/Tokyo";

/** 取得する日数。朝に知りたいのは今日と明日まで。 */
const FORECAST_DAYS = 2;

/** 既定の地点。myroom の `OUTDOOR_LAT` / `OUTDOOR_LON` と同じ値にしてある。 */
const DEFAULT_LATITUDE = 34.82;
const DEFAULT_LONGITUDE = 135.56;

export interface WeatherConfig {
  latitude: number;
  longitude: number;
}

/**
 * 数値の環境変数を読む。**壊れた値は既定値へ落とさず例外にする。**
 *
 * 黙って既定へ戻すと、書き間違えた座標のまま「別の地点の予報が正常に取れている」状態になり、
 * 画面にも通知にも異常が出ない。設定ミスは取得前に落として気づけるようにする。
 */
function readCoordinate(name: string, fallback: number, limit: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value) || Math.abs(value) > limit) {
    throw new Error(`${name} の値が座標として不正です（-${limit}〜${limit} の数値で指定します）`);
  }
  return value;
}

/**
 * 地点の設定を読む。
 *
 * 認証情報を持たないコネクタなので、**未設定でも既定値で動く**（トークンが無ければ
 * 何もしない ops-dashboard 等とはここが違う）。
 */
export function readWeatherConfig(): WeatherConfig {
  return {
    latitude: readCoordinate("AIDE_WEATHER_LAT", DEFAULT_LATITUDE, 90),
    longitude: readCoordinate("AIDE_WEATHER_LON", DEFAULT_LONGITUDE, 180),
  };
}

/** 実際に叩くURL。テストから組み立てだけを確かめられるよう分けてある。 */
export function forecastUrl(config: WeatherConfig): string {
  const params = new URLSearchParams({
    latitude: String(config.latitude),
    longitude: String(config.longitude),
    // 朝に知りたいものだけ。時間別（hourly）は要求しない——量が2桁増えるのに、
    // 「今日は傘が要るか」の判断には日ごとの最大値で足りる。
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    timezone: TIMEZONE,
    forecast_days: String(FORECAST_DAYS),
  });
  return `${ENDPOINT}?${params}`;
}

/**
 * 今日・明日の予報を取得する。
 *
 * **失敗はその場で `Error` に丸める。** worker の失敗理由はSignalyの通知本文へ載るため、
 * URLを含む素の例外を投げると座標（＝自宅の位置）が通知に出る。ステータスと種別だけを残す。
 */
export async function fetchWeatherForecast(config: WeatherConfig): Promise<WeatherForecast> {
  let response: Response;
  try {
    response = await fetch(forecastUrl(config), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (cause) {
    if (cause instanceof Error && cause.name === "TimeoutError") {
      throw new Error(`Open-Meteo が ${TIMEOUT_MS}ms 以内に応答しませんでした`);
    }
    throw new Error("Open-Meteo へ接続できませんでした");
  }

  if (!response.ok) {
    // 429 は利用回数の条件（1日10,000回未満）に触れた合図なので、他と区別できるようにする。
    const note = response.status === 429 ? "（利用回数の上限）" : "";
    throw new Error(`Open-Meteo が HTTP ${response.status} を返しました${note}`);
  }

  let raw: OpenMeteoDailyResponse;
  try {
    raw = (await response.json()) as OpenMeteoDailyResponse;
  } catch {
    throw new Error("Open-Meteo の応答をJSONとして読めませんでした");
  }

  const forecast = parseForecast(raw);
  if (forecast.days.length === 0) {
    throw new Error("Open-Meteo の応答に予報が含まれていませんでした");
  }
  return forecast;
}

export { describeWeatherCode, OPEN_METEO_ATTRIBUTION, parseForecast } from "./parse.ts";
export type { WeatherDay, WeatherForecast, WeatherLocation } from "./types.ts";
