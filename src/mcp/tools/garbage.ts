import { tokyoDate } from "../../core/tokyo-date.ts";
import { buildGarbage } from "../../core/views/garbage.ts";
import type { Tool } from "../types.ts";

const MIN_OFFSET_DAYS = -31;
const MAX_OFFSET_DAYS = 90;

function shiftDate(date: string, days: number): string | null {
  const at = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== date) return null;
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/** `date`（省略時は日本時間の今日）へ `offsetDays` を加える。 */
export function resolveGarbageDate(args: Record<string, unknown>, now: Date): string | undefined {
  const rawDate = typeof args["date"] === "string" ? args["date"].trim() : "";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : undefined;
  const rawOffset = args["offsetDays"];
  if (typeof rawOffset !== "number" || !Number.isInteger(rawOffset) || rawOffset === 0) return date;
  const offset = Math.min(Math.max(rawOffset, MIN_OFFSET_DAYS), MAX_OFFSET_DAYS);
  return shiftDate(date ?? tokyoDate(now), offset) ?? date;
}

function readCategory(args: Record<string, unknown>): string | undefined {
  const value = typeof args["category"] === "string" ? args["category"].trim() : "";
  return value === "" ? undefined : value;
}

export const garbageCollectionTool: Tool = {
  name: "aide_garbage_collection",
  description:
    "ゴミ収集日の収集区分と次回日を返す。" +
    "「今日出せるごみは」「次の不燃ごみはいつ」「今週のゴミ収集日は」を尋ねられたときに呼ぶ。" +
    "date（既定は日本時間の今日）を起点に、当日の収集区分は collectionsOnDate、" +
    "区分ごとの次回収集日は nextCollections で返す。category に myroom の収集区分名（例: 不燃ごみ）を" +
    "指定すると、その区分だけに絞れる。" +
    "「明日」「明後日」のような相対的な日は offsetDays（明日なら1）で指定し、日付を自分で計算しないこと。" +
    "note は区分に付いた注意事項。" +
    "検索範囲は最大31日で、myroomがDaySpanへ書き出したデータだけを読む。" +
    "complete が false、または結果が空のときは、収集が無いのではなく取得失敗・未設定・未同期の可能性もあるため note と unavailable を確認すること。" +
    "**予定・タスク・空き時間は返さない**（それは aide_schedule）。収集日を変更するツールではない。",
  inputSchema: {
    type: "object",
    properties: {
      date: {
        type: "string",
        description: "検索の起点日（YYYY-MM-DD）。省略すると日本時間の今日。",
      },
      offsetDays: {
        type: "integer",
        minimum: MIN_OFFSET_DAYS,
        maximum: MAX_OFFSET_DAYS,
        description: "date（省略時は今日）から何日ずらすか。明日なら1、明後日なら2。既定は0。",
      },
      category: {
        type: "string",
        description: "myroomで設定された収集区分名。例: 不燃ごみ。省略すると全区分を返す。",
      },
    },
    additionalProperties: false,
  },
  handler: async (args) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(
          await buildGarbage({ date: resolveGarbageDate(args, new Date()), category: readCategory(args) }),
          null,
          2,
        ),
      },
    ],
    isError: false,
  }),
};
