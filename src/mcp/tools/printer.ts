import { buildPrinterStatus } from "../../core/views/printer.ts";
import type { Tool } from "../types.ts";

/**
 * 3Dプリンターの状態の読み取り（#378）。
 *
 * 収集はサブPCの常駐プロセス（ローカルMQTT）、正規化は myroom が持つ。AIDEは myroom の内部API
 * を1回叩いて、「いまどうなっているか」に答えられる形へ畳むだけ。
 *
 * **返すのは1つの問い（「3Dプリンターはいまどうなっているか」）まで。** 進捗・残り時間・完了・
 * エラー・温度・レイヤー・AMS Lite は同じ1台の同じ時点の値で、分けると同じ鮮度の確認を
 * 何度も要求することになる。部屋の温度は別の問い（`aide_room_sensors`）。
 *
 * **鮮度が切れているときは現在の値を返さない**（`printer` が null になり、最後に確認できた
 * 値は `lastKnown` へ時刻付きで分かれる）。詳細は `src/core/views/printer.ts`。
 */
export const printerStatusTool: Tool = {
  name: "aide_printer_status",
  description:
    "3Dプリンター（Bambu Lab A1 mini）のいまの状態を返す。印刷状態（待機・準備・印刷中・一時停止・完了・失敗）・" +
    "ジョブ名・進捗率・現在レイヤー／総レイヤー・残り時間と終了予測時刻・ノズルとベッドの温度（現在／目標）・" +
    "印刷速度モード・AMS Lite（スロットごとの材料・色・残量）・エラーと最終更新時刻を含む。" +
    "「3Dプリンターの進捗は」「あと何分で終わる」「印刷は完了したか」「エラーは出ていないか」" +
    "「フィラメントの残りは」を尋ねられたときに呼ぶ。" +
    "**まず freshness と fresh を見ること。** fresh が true のときだけ printer を現在の状態として答えてよい。" +
    "fresh が false（stale＝状態の収集が止まっている・disconnected＝プリンターに接続できていない・never＝一度も届いていない）のときは、" +
    "printer が null で、**現在の状態は分からない**（電源が切れている可能性がある）。" +
    "その場合に lastKnown があっても最後に確認できた時刻（asOf）時点の値で、現在の値ではない。" +
    "「印刷中」「あと◯分」のように現在形で答えず、最終更新の時刻と一緒に「最後に確認できたのは◯分前で…」と伝えること。" +
    "complete が false のときは取得そのものができていない（不調と、プリンターが止まっていることは別）。" +
    "problems に気になる点（エラー・失敗・一時停止・鮮度切れ）が1行ずつ入る。" +
    "**プリンターを操作するツールではない**（読み取りだけ。印刷の開始・停止・一時停止はできない）。" +
    "**部屋の室温・湿度・CO2は返さない**（それは aide_room_sensors）。履歴・過去の印刷の一覧も返さない。",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async () => {
    const status = await buildPrinterStatus();
    return {
      content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
      // 未設定・取得失敗・鮮度切れは「エラー」ではなく状態。isErrorにするとClaudeが再試行して無駄になる。
      isError: false,
    };
  },
};
