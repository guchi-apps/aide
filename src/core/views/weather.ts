import { readCache } from "../cache/store.ts";
import type { CachedValue } from "../cache/store.ts";
import { tokyoDate } from "../tokyo-date.ts";
import type { WeatherDay, WeatherForecast } from "../connectors/weather/types.ts";
import { WEATHER_CACHE_KEY } from "../../worker/jobs/weather-sync.ts";

/**
 * 天気の読み取り（guchi-apps/question#7・aide#36 → #373）。
 *
 * **もとは朝のブリーフィングの横断ビューだった。** 「今日はどんな感じ？」の1回の呼び出しへ
 * 予定・交通・天気を畳んで返していたが、#373 でMCPツールを問いの単位へ分け直し、
 * 予定は `aide_schedule`、天気は `aide_weather` が答えることにしたため、畳み込みの側を畳んだ。
 * 交通はそもそも取得元が未定（trainrouteの廃止により白紙。aide#265）で、
 * 「未接続」とだけ返す欄を持ち回る意味が無くなった。
 *
 * **天気は weather-sync が毎時書いたキャッシュを読むだけ。** 取得は行わない。
 *
 * **鮮度はソースの基準で持つ。** 毎時更新のキャッシュなので、3回ぶん飛んだら気づける値で
 * `stale` を立てる。
 */

/**
 * 天気キャッシュがこれ以上古ければ鮮度切れとみなす。
 * weather-sync は毎時なので、3回ぶん飛んだら気づける値（`JOB_CATALOG` と同じ180分）。
 */
export const WEATHER_STALE_AFTER_MINUTES = 180;

/** 日付の区切りに使うタイムゾーン。「今日」はJSTの暦日で切る。 */
export const WEATHER_TIMEZONE = "Asia/Tokyo";

/**
 * 予報の状態。
 *
 * - `ok` … 中身が入っている
 * - `unavailable` … 取得できなかった（または対象日ぶんがキャッシュに無い）
 *
 * **「取得できなかった」と「そういう天気だ」を取り違えさせないために状態で持つ。**
 */
export type WeatherSectionState = "ok" | "unavailable";

/** 予報ぶんの器。鮮度（`fetchedAt` / `ageMinutes` / `stale`）を中身と一緒に持つ。 */
export interface WeatherSection<T> {
  state: WeatherSectionState;
  /** そのソースを取得した時刻。取れていなければ null。 */
  fetchedAt: string | null;
  /** 取得からの経過分数。 */
  ageMinutes: number | null;
  /** そのソースの基準で鮮度切れか。**基準はソースごとに違う。** */
  stale: boolean;
  /** `ok` でない理由。`ok` なら null。 */
  reason: string | null;
  data: T | null;
}

/** 天気セクションの中身。**座標は載せない**（自宅の位置にあたるため。README のOpen-Meteo節）。 */
export interface WeatherForecastDays {
  /** 対象日（JSTの暦日）の予報。キャッシュに含まれていなければ null。 */
  today: WeatherDay | null;
  /**
   * 翌日の予報。含まれていなければ null。
   *
   * **深夜0時台は毎日 null になる。** 取得は今日・明日の2日ぶん固定（`FORECAST_DAYS`）なので、
   * 日付が変わってから次の毎時同期が走るまでは、キャッシュの中身が「前日・当日」のままになる。
   * この間もキャッシュ自体は新しいため `stale` にはならない。
   */
  tomorrow: WeatherDay | null;
  /** CC BY 4.0 の帰属表示。データと一緒に持ち回る。 */
  attribution: string;
}

/** `YYYY-MM-DD` の翌日。ISO形式なので文字列のまま扱える。 */
function nextDate(date: string): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + 1);
  return at.toISOString().slice(0, 10);
}

/**
 * 天気キャッシュを対象日の粒度へ畳む。**純粋関数。テストはここに集中する。**
 *
 * **日付で突き合わせる。配列の先頭を「今日」とみなさない。** キャッシュは日付をまたいで
 * 残るため、添字で取ると日付が変わった直後に昨日の予報を「今日」として返してしまう。
 */
export function summarizeWeatherSection(
  cached: CachedValue<WeatherForecast> | null,
  date: string,
): WeatherSection<WeatherForecastDays> {
  if (!cached) {
    return {
      state: "unavailable",
      fetchedAt: null,
      ageMinutes: null,
      stale: true,
      reason: "天気予報をまだ一度も取得していない（worker の weather-sync ジョブが未実行）",
      data: null,
    };
  }

  const stale = cached.ageMinutes > WEATHER_STALE_AFTER_MINUTES;
  const days = cached.data.days ?? [];
  const today = days.find((day) => day.date === date) ?? null;
  const tomorrow = days.find((day) => day.date === nextDate(date)) ?? null;

  if (!today) {
    // 予報は取れているが対象日を含んでいない＝日付をまたいだまま更新が止まっている。
    // 明日ぶんだけ返しても「今日の天気」には答えられないので、状態として返す。
    return {
      state: "unavailable",
      fetchedAt: cached.fetchedAt,
      ageMinutes: cached.ageMinutes,
      stale: true,
      reason: `取得済みの予報に ${date} が含まれていない（weather-sync が止まっている可能性）`,
      data: null,
    };
  }

  return {
    state: "ok",
    fetchedAt: cached.fetchedAt,
    ageMinutes: cached.ageMinutes,
    stale,
    reason: null,
    data: { today, tomorrow, attribution: cached.data.attribution },
  };
}

/** `aide_weather` が返す形。予報の器に、対象日と組み立ての断り書きを添えたもの。 */
export interface WeatherView extends WeatherSection<WeatherForecastDays> {
  checkedAt: string;
  /** 対象日（`YYYY-MM-DD`・JST）。 */
  date: string;
  /** 日付をどのタイムゾーンで切ったか。 */
  timezone: string;
  note: string;
}

/**
 * MCPツール（`aide_weather`）から呼ばれる入口。
 *
 * 対象日はJSTの暦日で切る。**キャッシュを読むだけなので、失敗しても状態として返る**
 * （`summarizeWeatherSection` が `unavailable` を組み立てる）。
 */
export async function buildWeather(now: Date = new Date()): Promise<WeatherView> {
  const date = tokyoDate(now);
  const forecast = summarizeWeatherSection(await readCache<WeatherForecast>(WEATHER_CACHE_KEY), date);

  const notes = [`${date}（${WEATHER_TIMEZONE} の暦日）を「今日」として組み立てている。`];
  if (forecast.state !== "ok") {
    // 欠けたことを「天気の情報が無い」と読ませないための断り書き。
    notes.push("state が ok でないのは予報を取得できていないだけで、そういう天気だという意味ではない。");
  }
  if (forecast.state === "ok" && forecast.data?.tomorrow === null) {
    // 深夜0時台は毎日ここへ来る（取得は2日ぶん固定で、日付が変わると「明日」が抜ける）。
    notes.push(
      "明日ぶんの予報はまだ取得済みのキャッシュに含まれていない（次の毎時同期で入る）。" +
        "明日の天気が無いという意味ではない。",
    );
  }

  return {
    checkedAt: now.toISOString(),
    date,
    timezone: WEATHER_TIMEZONE,
    ...forecast,
    note: notes.join(" "),
  };
}
