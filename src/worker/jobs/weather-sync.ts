import { fetchWeatherForecast, readWeatherConfig } from "../../core/connectors/weather/index.ts";
import { publish } from "../sink.ts";

/** 天気予報キャッシュのキー。参照側（横断ビュー）と共有する。 */
export const WEATHER_CACHE_KEY = "weather-forecast";

/**
 * Open-Meteo から今日・明日の予報を取得してキャッシュを更新する。
 *
 * **取得そのものは軽い**（HTTP GETが1本）。それでもキャッシュを挟むのは、
 * Open-Meteo の無料枠に利用回数の条件（1日10,000回未満）があり、呼ばれた回数だけ
 * 外部へ出ていく作りにしたくないため。予報は毎時更新なので、毎時取れば鮮度も足りる。
 *
 * 書き出し先はローカルかリモートかを sink が判断する（本番では worker がサブPC、
 * サーバーがVPSで別マシンのため、HTTPで送る）。
 */
export async function runWeatherSync(): Promise<string> {
  const forecast = await fetchWeatherForecast(readWeatherConfig());
  const destination = await publish(WEATHER_CACHE_KEY, "open-meteo", forecast);
  // 座標は自宅の位置にあたるので、ログにも通知にも出さない（日数と天気だけを出す）。
  const summary = forecast.days.map((day) => `${day.date} ${day.summary}`).join(" / ");
  return `${forecast.days.length}日ぶんの予報（${summary}）を取得し、${destination}`;
}
