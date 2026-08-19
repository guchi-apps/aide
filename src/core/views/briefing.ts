import { readCache } from "../cache/store.ts";
import type { CachedValue } from "../cache/store.ts";
import { tokyoDate } from "../connectors/subscriptions/index.ts";
import type { WeatherDay, WeatherForecast } from "../connectors/weather/types.ts";
import { WEATHER_CACHE_KEY } from "../../worker/jobs/weather-sync.ts";

/**
 * 朝のブリーフィングの横断ビュー（guchi-apps/question#7・aide#36）。
 *
 * 「今日はどんな感じ？」の1回の呼び出しへ、**今日の予定・交通・天気**を畳んで返す。
 * Claudeに3つのソースを個別に叩かせると往復もトークンも増えるため、AIDE側で1本にする。
 * README「Core と MCP層の境界」でいう横断ビューそのものにあたる。
 *
 * **セクションごとに独立して失敗させる。** 予定が取れなくても天気は返せるし、その逆もある。
 * 全体を例外にすると、答えられたはずの問いまで答えられなくなる（money ビューが
 * subscription-lists の失敗を握るのと同じ立て付け）。
 *
 * **鮮度はビュー全体で揃えず、ソースごとに持つ。** 天気は毎時更新のキャッシュ、交通は分単位、
 * 予定は都度と性質が違うため、1つの `stale` に潰すと意味が壊れる。
 *
 * 現時点で実データを返せるのは天気だけで、予定（dayspan#236 ＋ AIDE側コネクタ）と
 * 交通（aide#33）は**未接続として返す**。コネクタが揃った順に、該当セクションを
 * 差し替えるだけで足せる形にしてある。
 */

/**
 * 天気キャッシュがこれ以上古ければ鮮度切れとみなす。
 * weather-sync は毎時なので、3回ぶん飛んだら気づける値（`JOB_CATALOG` と同じ180分）。
 */
export const WEATHER_STALE_AFTER_MINUTES = 180;

/** 日付の区切りに使うタイムゾーン。「今日」はJSTの暦日で切る。 */
export const BRIEFING_TIMEZONE = "Asia/Tokyo";

/**
 * セクションの状態。
 *
 * - `ok` … 中身が入っている
 * - `unavailable` … 接続は設定されているが取得できなかった（または対象日ぶんが無い）
 * - `not_configured` … 接続が設定されていない（トークン等が未設定）
 * - `not_connected` … コネクタ自体がまだ無い。依存Issueの完了待ち
 *
 * `unavailable` と `not_connected` を分けているのは、**前者は直せば取れる／後者はまだ存在しない**
 * という違いをClaudeに伝えるため。どちらも「情報が無い」だが、言うべきことが違う。
 */
export type BriefingSectionState = "ok" | "unavailable" | "not_configured" | "not_connected";

/**
 * 1セクションぶんの器。
 *
 * ソースが増えても形を揃えるために共通化してある。ニュース等を後から足すときも
 * この器へ入れれば、読む側（Claude）の読み方は変わらない。
 */
export interface BriefingSection<T> {
  state: BriefingSectionState;
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

/**
 * コネクタがまだ無いソースの器。
 *
 * 型引数を `never` にしてあるので `data` は常に `null` になる。コネクタが入った時点で
 * `BriefingSection<実際の型>` へ差し替える。
 */
export type PendingSection = BriefingSection<never>;

/** 天気セクションの中身。**座標は載せない**（自宅の位置にあたるため。README のOpen-Meteo節）。 */
export interface BriefingWeather {
  /** 対象日（JSTの暦日）の予報。キャッシュに含まれていなければ null。 */
  today: WeatherDay | null;
  /** 翌日の予報。含まれていなければ null。 */
  tomorrow: WeatherDay | null;
  /** CC BY 4.0 の帰属表示。データと一緒に持ち回る。 */
  attribution: string;
}

export interface DailyBriefing {
  checkedAt: string;
  /** 対象日（`YYYY-MM-DD`・JST）。 */
  date: string;
  /** 日付をどのタイムゾーンで切ったか。 */
  timezone: string;
  /** 全セクションが `ok` か。false なら `unavailable` にどれが欠けたかが入る。 */
  complete: boolean;
  /** 中身を返せなかったソースと理由。 */
  unavailable: { source: string; reason: string }[];
  /** 今日の予定（DaySpan）。 */
  schedule: PendingSection;
  /** 交通（trainroute）。 */
  transit: PendingSection;
  /** 今日・明日の天気（Open-Meteo）。 */
  weather: BriefingSection<BriefingWeather>;
  note: string;
}

/** `YYYY-MM-DD` の翌日。ISO形式なので文字列のまま扱える。 */
function nextDate(date: string): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + 1);
  return at.toISOString().slice(0, 10);
}

/** まだコネクタが無いソースの答え。 */
function pendingSection(reason: string): PendingSection {
  return { state: "not_connected", fetchedAt: null, ageMinutes: null, stale: false, reason, data: null };
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
): BriefingSection<BriefingWeather> {
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

/**
 * セクションを対象日ぶんの答えへ組み立てる。**純粋関数。**
 *
 * 取得はここでは行わない（引数で受け取る）。組み立ての規則だけをテストできるようにしてある。
 */
export function assembleBriefing(
  now: Date,
  date: string,
  sections: {
    schedule: PendingSection;
    transit: PendingSection;
    weather: BriefingSection<BriefingWeather>;
  },
): DailyBriefing {
  const entries = [
    { source: "dayspan", section: sections.schedule as BriefingSection<unknown> },
    { source: "trainroute", section: sections.transit as BriefingSection<unknown> },
    { source: "open-meteo", section: sections.weather as BriefingSection<unknown> },
  ];

  const unavailable = entries
    .filter((entry) => entry.section.state !== "ok")
    .map((entry) => ({ source: entry.source, reason: entry.section.reason ?? "取得できなかった" }));

  const notes = [
    `${date}（${BRIEFING_TIMEZONE} の暦日）を「今日」として組み立てている。`,
    "鮮度はソースごとに基準が違うため、各セクションの stale を見ること。",
  ];
  if (unavailable.length > 0) {
    // 欠けたソースを「無い」と読ませないための断り書き。
    // 「予定が取れなかった」と「予定が無い」は違う。
    notes.push(
      "state が ok でないセクションは中身を取得できていないだけで、" +
        "そのソースに予定・情報が無いという意味ではない。",
    );
  }
  if (entries.some((entry) => entry.section.state === "not_connected")) {
    notes.push("not_connected のセクションはコネクタ自体が未実装で、設定を直しても取得できない。");
  }

  return {
    checkedAt: now.toISOString(),
    date,
    timezone: BRIEFING_TIMEZONE,
    complete: unavailable.length === 0,
    unavailable,
    schedule: sections.schedule,
    transit: sections.transit,
    weather: sections.weather,
    note: notes.join(" "),
  };
}

/**
 * MCPツールから呼ばれる入口。
 *
 * **キャッシュを読むだけで、外部への取得は行わない**（README「取得と提供の分離」）。
 * 天気は weather-sync が毎時書いたものを読む。交通・予定のコネクタが入ったら、
 * localhost への軽いHTTP GETを**短いタイムアウト付きで**ここへ足す。
 */
export async function buildDailyBriefing(now: Date = new Date()): Promise<DailyBriefing> {
  const date = tokyoDate(now);
  const weather = summarizeWeatherSection(await readCache<WeatherForecast>(WEATHER_CACHE_KEY), date);

  return assembleBriefing(now, date, {
    schedule: pendingSection(
      "予定のコネクタが未実装（DaySpan側のGET API: guchi-apps/dayspan#236 待ち）",
    ),
    transit: pendingSection("交通のコネクタが未実装（guchi-apps/aide#33 待ち）"),
    weather,
  });
}
