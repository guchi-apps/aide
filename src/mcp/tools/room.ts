import { buildRoomStatus } from "../../core/views/room.ts";
import type { Tool } from "../types.ts";

/**
 * 部屋の状態の横断ビュー。
 *
 * 温度・湿度・気圧・CO2・照度とエアコンの状態は myroom が集めているが、あちらの読み取りAPIは
 * ログインしたブラウザ向けで、ClaudeアプリからVPS上のAPIへ直接HTTPリクエストすることも
 * できない。部屋の状態を知る経路はMCPサーバーしかなく、**AIDEにしかできない領域**にあたる。
 *
 * センサーごとの値・鮮度・エアコン・屋外との対比を1つの答えに畳むため、README
 * 「Core と MCP層の境界」が言う横断ビューに該当する。公式MCPとも重複しない。
 */
export const roomStatusTool: Tool = {
  name: "aide_room_status",
  description:
    "いまの部屋の状態を返す。センサーごとの室温・湿度・気圧・CO2・照度と最終測定時刻、" +
    "エアコンの運転状態（電源・運転モード・設定温度・風量）、屋外の気温・湿度・気圧と室内との気温差を含む。" +
    "「いま部屋は暑いか」「換気したほうがよいか」「エアコンはついているか」「今の室温は」" +
    "を尋ねられたときに呼ぶ。" +
    "problems に気になる点が1行ずつ入るので、まずそこを見ること。ok が true なら判定できた範囲で問題なし。" +
    "stale が true のセンサーは受信が止まっており、値は最後に受信した時点のもので現在の値ではない" +
    "（この場合その値は problems の判定に使っていない）。" +
    "complete が false のときは取得そのものができておらず、部屋の状態は分からないという意味になる。" +
    "履歴・日別統計・記録の一覧は返さない（必要なら myroom の画面を見る）。",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async () => {
    const status = await buildRoomStatus();
    return {
      content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
      // 未設定・取得失敗は「エラー」ではなく状態。isErrorにするとClaudeが再試行して無駄になる。
      isError: false,
    };
  },
};
