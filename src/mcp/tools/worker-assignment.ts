import { type AssignmentView, readAssignmentView, setAssignmentMode } from "../../api/worker-assignment.ts";
import { WORKER_HOSTS, isAssignmentMode } from "../../core/worker-assignment.ts";
import type { Tool, ToolResult } from "../types.ts";

/**
 * worker ジョブの担当ホストの表示と切り替え（#891）。
 *
 * 読み取りと書き込みは別のツールにする（クライアント側で「常に許可」にしたときに、
 * 切り替えまで素通しにならないように。`catalog.ts` の方針）。
 */

function text(view: AssignmentView): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(view, null, 2) }] };
}

export const workerAssignmentTool: Tool = {
  name: "aide_worker_assignment",
  description:
    "aide の worker ジョブ（Zaim巡回・天気・gmail-watch 等）をいまどのホスト（subpc＝DeskMini／macmini＝Mac mini）が担当しているかを返す。" +
    "モード（auto＝主のDeskMiniが止まったら自動でMac miniへ／subpc・macmini＝固定）、各ホストが最後にAIDEへ問い合わせた時刻と生存判定、" +
    "最後の切り替え（時刻・理由 failover/failback/manual）を含む。**読み取り専用**。" +
    "切り替えは aide_set_worker_assignment を使う。",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async () => text(await readAssignmentView()),
};

export const setWorkerAssignmentTool: Tool = {
  name: "aide_set_worker_assignment",
  description:
    "aide の worker ジョブの担当ホストのモードを切り替える。**書き込みツール**。" +
    "mode=subpc（DeskMiniに固定）／macmini（Mac miniに固定）は、止まっていても自動では移さず解除するまで続く" +
    "（メンテナンス・再起動・Mac miniでの動作確認の前に使う）。mode=auto で自動（主はDeskMini、問い合わせが15分途切れたらMac miniへ、" +
    "DeskMiniが30分続いたら戻す）に戻す。担当が変わると、新しい担当ホストの次のジョブ実行時にDiscordへ通知される。" +
    "Zaimのログイン状態はホストごとに別なので、移した先で再ログインが要ることがある。",
  inputSchema: {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["auto", ...WORKER_HOSTS], description: "auto・subpc・macmini のいずれか" },
    },
    required: ["mode"],
    additionalProperties: false,
  },
  handler: async (args) => {
    const mode = args["mode"];
    if (!isAssignmentMode(mode)) {
      return {
        content: [{ type: "text", text: `mode は auto・${WORKER_HOSTS.join("・")} のいずれかです` }],
        isError: true,
      };
    }
    const view = await setAssignmentMode(mode);
    console.log(`[worker-assignment] MCPからモードを ${mode} にしました（担当 ${view.owner}）`);
    return text(view);
  },
};
