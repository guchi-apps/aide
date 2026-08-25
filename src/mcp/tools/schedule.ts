import {
  DEFAULT_FREE_WINDOW,
  buildSchedule,
  parseClock,
  type TimeWindow,
} from "../../core/views/schedule.ts";
import type { Tool } from "../types.ts";

/**
 * 予定の横断ビュー（aide#173）。
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
 * **`aide_daily_briefing` とは用途を書き分ける。** あちらは「今日1日の見通し」を天気・交通と
 * 一緒に1回で返すもので、日付も今日に固定されている。こちらは**期間を指定して予定そのものと
 * 空き時間を見る**ためのもの。書き分けないと、横断ビュー同士でツール選択が曖昧になる。
 */

/** 一度に返す日数の上限。DaySpan側の上限は31日だが、応答が膨らむため短く切る。 */
const MAX_DAYS = 14;

/** 期限切れタスクを遡る日数（`includeOverdueTasks` を指定したとき）。DaySpan側の既定と同じ。 */
const OVERDUE_DAYS = 30;

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
    "**予定の出どころはDaySpanで、Googleカレンダーの予定とNotionのタスク・日付リマインドが" +
    "統合済みのものが返る。** タスクの詳細な編集や検索はNotion側の役割で、ここでは扱わない。" +
    "freeSlots は freeWindow（既定 08:00〜22:00・freeFrom / freeTo で変えられる）の範囲で、" +
    "時刻の決まった予定・移動のどちらとも重ならない30分以上の時間帯。" +
    "**終日の予定は時間帯を持たないため freeSlots を塞いでいない**ので、allDayCount も併せて見ること。" +
    "時刻はすべてDaySpanが設定タイムゾーン（既定 Asia/Tokyo）で描いた HH:MM で、" +
    "こちらで時差を足し引きしないこと。" +
    "configured が false なら接続が未設定、complete が false なら取得できなかったものがあり、" +
    "**どちらも「予定が無い」という意味ではない**。" +
    "sources.googleConnected が false のときも events が空になるが、これは未接続を意味する。" +
    "**今日1日の見通し（予定に加えて天気・交通）が欲しいときは aide_daily_briefing を呼ぶこと。**",
  inputSchema: {
    type: "object",
    properties: {
      date: {
        type: "string",
        description:
          "起点の日付（YYYY-MM-DD）。省略すると今日（DaySpanの設定タイムゾーンでの暦日）。" +
          "**呼び出し側で時差を考えて日付を作り直さないこと。**",
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
    const rawDate = typeof args["date"] === "string" ? args["date"].trim() : "";
    // 形式だけ見て通す。実在しない日付（2026-02-30 等）の判定はDaySpan側が持っており、
    // こちらで二重に持つと基準が食い違う。
    const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : undefined;

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
