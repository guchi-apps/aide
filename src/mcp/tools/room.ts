import { buildRoomStatus } from "../../core/views/room.ts";
import type { RoomProblemSource, RoomStatus } from "../../core/views/room.ts";
import type { Tool, ToolResult } from "../types.ts";

/**
 * 部屋の状態の読み取り（#373）。
 *
 * 温度・湿度・気圧・CO2・照度とエアコンの状態は myroom が集めているが、あちらの読み取りAPIは
 * ログインしたブラウザ向けで、ClaudeアプリからVPS上のAPIへ直接HTTPリクエストすることも
 * できない。部屋の状態を知る経路はMCPサーバーしかなく、**AIDEにしかできない領域**にあたる。
 *
 * **センサーとエアコンで2本に分けている。** 以前は `aide_room_status` 1本で、「エアコンは
 * ついているか」だけを尋ねられたときにも全センサーの測定値と屋外との対比まで返っていた。
 *
 * **取得元（`buildRoomStatus()`）は2本とも共通で、myroom を1回叩く。** Core は変えず、
 * MCP層で自分の区画だけを切り出す。
 */

function json(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    // 未設定・取得失敗は「エラー」ではなく状態。isErrorにするとClaudeが再試行して無駄になる。
    isError: false,
  };
}

/**
 * 区画ひとつぶんの共通の枠。**`ok` はその区画だけで判定し直す**（ops ツールと同じ理由）。
 */
function section(
  status: RoomStatus,
  source: RoomProblemSource,
  judged: boolean,
): Record<string, unknown> {
  const problems = status.problems.filter((problem) => problem.source === source);
  return {
    checkedAt: status.checkedAt,
    configured: status.configured,
    ok: judged && problems.length === 0,
    complete: status.complete,
    problems,
    measuredAt: status.measuredAt,
    unavailable: status.unavailable,
    note: status.note,
  };
}

export const roomSensorsTool: Tool = {
  name: "aide_room_sensors",
  description:
    "いまの部屋の測定値を返す。センサーごとの室温・湿度・気圧・CO2・照度と最終測定時刻、" +
    "屋外の気温・湿度・気圧と室内との気温差を含む。" +
    "「いま部屋は暑いか」「今の室温は」「換気したほうがよいか」「CO2は高くないか」" +
    "を尋ねられたときに呼ぶ。" +
    "**ここで返すのはいまの実測値**で、今日・明日の予報ではない（予報は aide_weather）。" +
    "**エアコンの運転状態は返さない**（それは aide_aircon_status）。" +
    "**3Dプリンターの状態は返さない**（それは aide_printer_status）。" +
    "problems に気になる点が1行ずつ入るので、まずそこを見ること。ok が true なら判定できた範囲で問題なし。" +
    "stale が true のセンサーは受信が止まっており、値は最後に受信した時点のもので現在の値ではない" +
    "（この場合その値は problems の判定に使っていない）。" +
    "complete が false のときは取得そのものができておらず、部屋の状態は分からないという意味になる。" +
    "履歴・日別統計・記録の一覧は返さない（必要なら myroom の画面を見る）。",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async () => {
    const status = await buildRoomStatus();
    return json({
      ...section(status, "sensors", status.sensors.length > 0),
      staleThresholdMinutes: status.staleThresholdMinutes,
      sensors: status.sensors,
      outdoor: status.outdoor,
    });
  },
};

export const airconStatusTool: Tool = {
  name: "aide_aircon_status",
  description:
    "エアコンの運転状態を返す。機器ごとの電源・運転モード・設定温度・風量・" +
    "機器が測っている室温と湿度、ネットワーク上に見えているか（online）を含む。" +
    "「エアコンはついているか」「設定温度は何度になっているか」「冷房と暖房どちらで動いているか」" +
    "を尋ねられたときに呼ぶ。" +
    "**部屋の室温・湿度・CO2・照度は返さない**（それは aide_room_sensors）。" +
    "power は機器が返した文字列そのままで、`on` / `off` 以外が入ることがある。" +
    "aircons が空ならエアコンの情報を取得できておらず、**エアコンが無い・止まっているという意味ではない**。" +
    "**このツールは読み取りだけで、エアコンは操作しない。** 照明などの操作は aide_room_buttons と aide_room_press。",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async () => {
    const status = await buildRoomStatus();
    return json({
      ...section(status, "aircons", status.aircons.length > 0),
      aircons: status.aircons,
    });
  },
};
