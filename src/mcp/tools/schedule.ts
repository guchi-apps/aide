import {
  DEFAULT_FREE_WINDOW,
  buildSchedule,
  parseClock,
  type TimeWindow,
} from "../../core/views/schedule.ts";
import type { Tool } from "../types.ts";

/**
 * 予定の読み取り（aide#173）。
 *
 * **Claudeアプリには公式のGoogleカレンダーコネクタがあるが、それはAnthropic製品側の機能で、
 * Messages APIから叩ける公開のリモートMCPサーバーのURLが存在しない。** そのため
 * aide-bot（`guchi-apps/aide-bot`）のような自前のクライアントからは予定へ一切届かない。
 * README「Core と MCP層の境界」でいう**公開のリモートMCPが無いもの**にあたるので、
 * AIDEが口を持ってよい領域になる。
 *
 * 取得先はGoogleカレンダーではなくDaySpanで、予定・タスク・日付リマインド・移動が
 * 統合済みのものを受け取る（`src/core/connectors/dayspan/index.ts`）。
 *
 * **今日の予定もこのツールが答える**（#373）。以前は「今日1日の見通し」を天気・交通と
 * 一緒に返す `aide_daily_briefing` があり、今日ぶんだけ答えが2本に割れていた。
 * MCPツールを問いの単位へ分け直したさいにあちらを畳み、天気は `aide_weather` へ移した。
 */

/** 一度に返す日数の上限。DaySpan側の上限は31日だが、応答が膨らむため短く切る。 */
const MAX_DAYS = 14;

/** 期限切れタスクを遡る日数（`includeOverdueTasks` を指定したとき）。DaySpan側の既定と同じ。 */
const OVERDUE_DAYS = 30;

/**
 * `offsetDays` で指定できる範囲。「先週の◯曜」「来月頭」までを想定し、それ以上は日付で指定させる。
 * 範囲外は丸める（拒否すると、ほぼ同じ問いで答えが返らなくなる）。
 */
const MIN_OFFSET_DAYS = -31;
const MAX_OFFSET_DAYS = 90;

/**
 * 「今日」を決めるタイムゾーン。**DaySpanの設定タイムゾーンの既定と同じ値**にしている。
 * `offsetDays` だけが指定されたときに、起点の日付をこちらで作る必要があるため。
 */
const TODAY_TIMEZONE = "Asia/Tokyo";

/**
 * `YYYY-MM-DD` をn日ずらす。暦日の計算なのでUTCで足し引きする（タイムゾーンに依らない）。
 *
 * **実在しない日付なら null。** `2026-02-30` は `Date` が黙って3月2日へ繰り上げるため、
 * 読み戻して一致するかで確かめる。ずらした結果がもっともらしい別の日になるより、
 * 元の日付のままDaySpanに400を返させたほうが誤りに気づける。
 */
export function shiftDate(date: string, days: number): string | null {
  const at = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== date) return null;
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/**
 * 起点の日付を決める。**純粋関数。**
 *
 * `offsetDays` は `date`（省略時は今日）からずらす日数で、「明日」なら1、「昨日」なら-1。
 * 呼び出し側のAIが今日の日付を取り違えても「明日」を正しく引けるようにするためのもの（#325）。
 * `offsetDays` が無ければ、`date` の省略は従来どおりDaySpan側の「今日」に任せる（undefined を返す）。
 */
export function resolveDate(args: Record<string, unknown>, now: Date): string | undefined {
  const rawDate = typeof args["date"] === "string" ? args["date"].trim() : "";
  // 形式だけ見て通す。実在しない日付（2026-02-30 等）の判定はDaySpan側が持っており、
  // こちらで二重に持つと基準が食い違う。
  const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : undefined;

  const rawOffset = args["offsetDays"];
  if (typeof rawOffset !== "number" || !Number.isInteger(rawOffset) || rawOffset === 0) return date;
  const offset = Math.min(Math.max(rawOffset, MIN_OFFSET_DAYS), MAX_OFFSET_DAYS);

  const base =
    date ?? new Intl.DateTimeFormat("en-CA", { timeZone: TODAY_TIMEZONE }).format(now);
  return shiftDate(base, offset) ?? date;
}

/** `HH:MM` として読めるものだけ通す。読めない値は既定へ倒す。 */
function clock(value: unknown): string | null {
  return typeof value === "string" && parseClock(value) !== null ? value : null;
}

/**
 * 空き時間を数える時間帯。
 *
 * **片側だけの指定を受け付ける**（「9時以降で」のような聞き方がそのまま来るため）。
 * 読めない値は既定へ倒し、前後が逆になったときは丸ごと既定へ戻す。指定を尊重して
 * 空の結果を返すより、既定の窓で答えたほうが問いに近い。
 */
export function readFreeWindow(args: Record<string, unknown>): TimeWindow {
  const from = clock(args["freeFrom"]) ?? DEFAULT_FREE_WINDOW.from;
  const to = clock(args["freeTo"]) ?? DEFAULT_FREE_WINDOW.to;
  if ((parseClock(to) ?? 0) <= (parseClock(from) ?? 0)) return { ...DEFAULT_FREE_WINDOW };
  return { from, to };
}

export const scheduleTool: Tool = {
  name: "aide_schedule",
  description:
    "指定した日から数日ぶんの予定・移動・タスク・日付リマインドと、**空いている時間帯**を返す。" +
    "「今日の予定は」「今週の予定は」「明日は空いているか」「何時なら空いているか」" +
    "「◯日に予定を入れられるか」を尋ねられたときに呼ぶ。" +
    "date（既定は今日）と days（既定1・最大14）で範囲を指定する。" +
    "**「明日」「明後日」「昨日」のような相対的な日は offsetDays（明日なら1）で指定し、" +
    "日付を自分で計算しないこと。** 返った range.from で実際に引いた日付を確認できる。" +
    "**予定の出どころはDaySpanで、Googleカレンダーの予定とNotionのタスク・日付リマインドが" +
    "統合済みのものが返る。** タスクの詳細な編集や検索はNotion側の役割で、ここでは扱わない。" +
    "freeSlots は freeWindow（既定 08:00〜22:00・freeFrom / freeTo で変えられる）の範囲で、" +
    "時刻の決まった予定・移動のどちらとも重ならない30分以上の時間帯。" +
    "**終日の予定は時間帯を持たないため freeSlots を塞いでいない**ので、allDayCount も併せて見ること。" +
    "**予定の events には中止・不参加の記録（outcome）と本文（description）が付く。** " +
    "outcome が CANCELED なら予定そのものが無くなった（中止）、ABSENT なら予定は行われたが自分は行かなかった（不参加）で、" +
    "null なら通常どおり行われる。**中止・不参加の予定も一覧から消えずに残る**ため、" +
    "「◯◯はキャンセルになったか」は outcome で判断し、存在しないから中止と読まないこと。" +
    "中止・不参加の予定は freeSlots・busyMinutes を塞がない。" +
    "description は予定のメモで、300文字で切ってあり（超えた分は末尾が …）、長文の全体は返さない。" +
    "**中止・不参加にした理由は返らない**（DaySpanのAPIが持ち出していない）。" +
    "時刻はすべてDaySpanが設定タイムゾーン（既定 Asia/Tokyo）で描いた HH:MM で、" +
    "こちらで時差を足し引きしないこと。" +
    "configured が false なら接続が未設定、complete が false なら取得できなかったものがあり、" +
    "**どちらも「予定が無い」という意味ではない**。" +
    "sources.googleConnected が false のときも events が空になるが、これは未接続を意味する。" +
    "**今日の予定もこのツールで引く**（date・offsetDays を省略すると今日）。" +
    "天気は返さないので、「今日はどんな感じ」のように天気も要る問いでは aide_weather も呼ぶこと。",
  inputSchema: {
    type: "object",
    properties: {
      date: {
        type: "string",
        description:
          "起点の日付（YYYY-MM-DD）。省略すると今日（DaySpanの設定タイムゾーンでの暦日）。" +
          "**呼び出し側で時差を考えて日付を作り直さないこと。**",
      },
      offsetDays: {
        type: "integer",
        minimum: MIN_OFFSET_DAYS,
        maximum: MAX_OFFSET_DAYS,
        description:
          "date（省略時は今日）から何日ずらすか。明日なら1、明後日なら2、昨日なら-1。既定は0。",
      },
      days: {
        type: "integer",
        minimum: 1,
        maximum: MAX_DAYS,
        description: "date から何日ぶん返すか。既定は1。今週ぶんなら7を指定する。",
      },
      includeOverdueTasks: {
        type: "boolean",
        description:
          "期限切れのタスク（最大30日前まで）を overdueTasks に含めるか。既定は false。" +
          "true にするとNotionへの問い合わせが1回増えるため、必要なときだけ指定する。",
      },
      freeFrom: {
        type: "string",
        description: "空き時間を数え始める時刻（HH:MM）。既定は 08:00。",
      },
      freeTo: {
        type: "string",
        description: "空き時間を数え終える時刻（HH:MM）。既定は 22:00。",
      },
    },
    additionalProperties: false,
  },
  handler: async (args) => {
    const date = resolveDate(args, new Date());

    const rawDays = args["days"];
    const days =
      typeof rawDays === "number" && Number.isInteger(rawDays)
        ? Math.min(Math.max(rawDays, 1), MAX_DAYS)
        : undefined;

    const summary = await buildSchedule({
      date,
      days,
      // 既定で取りにいかない。半年前に期限が過ぎたタスクを読み上げても行動は変わらず、
      // 遡るほどNotionへの往復が増える（DaySpan側 docs/internal-api.md）。
      overdueDays: args["includeOverdueTasks"] === true ? OVERDUE_DAYS : 0,
      freeWindow: readFreeWindow(args),
    });

    return {
      content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      // 未設定・取得失敗は「エラー」ではなく状態。isErrorにするとClaudeが再試行して無駄になる。
      isError: false,
    };
  },
};
