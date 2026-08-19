import { buildDailyBriefing } from "../../core/views/briefing.ts";
import type { Tool } from "../types.ts";

/**
 * 朝のブリーフィングの横断ビュー。
 *
 * 「今日はどんな感じ？」の1問へ、今日の予定・交通・天気を**1回の呼び出しで**返す。
 * Claudeに3ソースを個別に叩かせると往復もトークンも増えるため、AIDE側で1本に畳む。
 *
 * **単機能ツール（`aide_weather`・`aide_transit_delay` 等）は増やさない。** 各コネクタは
 * Core に置き、MCP層へ出す口はこのビューへ集約する（README「Core は広く、MCP層は狭く」）。
 */
export const dailyBriefingTool: Tool = {
  name: "aide_daily_briefing",
  description:
    "今日1日の見通しを1回でまとめて返す。今日の予定・交通・今日と明日の天気" +
    "（天気・最高／最低気温・降水確率）を含む。" +
    "「今日はどんな感じ」「今日の予定は」「今日の天気は」「傘は要るか」" +
    "を尋ねられたときに呼ぶ。" +
    "date はJSTの暦日で、その日を「今日」として組み立てている。" +
    "セクション（schedule・transit・weather）ごとに state があり、ok 以外は中身を取得できて" +
    "いないという意味で、そのソースに予定や情報が無いという意味ではない。" +
    "not_connected はコネクタ自体が未実装で、設定を直しても取得できない。" +
    "鮮度の基準はソースごとに違うため、全体ではなく各セクションの stale と ageMinutes を見ること。" +
    "complete が false でも、state が ok のセクションはそのまま使ってよい。",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async () => {
    const briefing = await buildDailyBriefing();
    return {
      content: [{ type: "text", text: JSON.stringify(briefing, null, 2) }],
      // 未接続・取得失敗は「エラー」ではなく状態。isErrorにするとClaudeが再試行して無駄になる。
      isError: false,
    };
  },
};
