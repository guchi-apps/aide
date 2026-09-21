import { buildWeather } from "../../core/views/weather.ts";
import type { Tool } from "../types.ts";

/**
 * 天気の読み取り（#373）。
 *
 * **もとは `aide_daily_briefing` として、今日の予定・交通・天気を1回で返していた。**
 * #373 でMCPツールを問いの単位へ分け直したさいに、予定は `aide_schedule`（日付を指定して
 * 引ける既存のツール）へ任せ、このツールは天気だけを答えることにした。交通は取得元が
 * 未定（aide#265）で、「未接続」とだけ返す欄を持ち回る意味が無かったため落とした。
 *
 * **MCPの同期リクエスト内で重い取得は行わない。** weather-sync が毎時書いたキャッシュを読むだけ。
 */
export const weatherTool: Tool = {
  name: "aide_weather",
  description:
    "今日と明日の天気予報を返す。日ごとの天気・最高／最低気温・降水確率を含む。" +
    "「今日の天気は」「明日は雨か」「傘は要るか」「明日の気温は」" +
    "を尋ねられたときに呼ぶ。" +
    "**返すのは予報**で、いまの室温・湿度やいまの屋外の実測ではない。" +
    "「いま暑いか」「いまの室温は」「換気したほうがよいか」のような" +
    "現在の実測値を尋ねられたときは aide_room_sensors を呼ぶこと。" +
    "**予定は返さない**（今日・明日の予定は aide_schedule）。" +
    "date はJSTの暦日で、その日を「今日」として組み立てている。" +
    "tomorrow は深夜0時台のみ null になることがある（次の毎時同期で入る）。" +
    "state が ok 以外のときは予報を取得できていないという意味で、" +
    "**そういう天気だという意味ではない**。" +
    "毎時更新のキャッシュを読んでおり、stale が true なら同期が止まっている。" +
    "attribution は出典の表示なので、予報をそのまま引用するときは添えること。",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async () => ({
    content: [{ type: "text", text: JSON.stringify(await buildWeather(), null, 2) }],
    // 未取得は「エラー」ではなく状態。isErrorにするとClaudeが再試行して無駄になる。
    isError: false,
  }),
};
