import { getProcessInfo } from "../../core/process-info.ts";
import type { Tool } from "../types.ts";

/** 疎通確認と、応答中の本番プロセスの版・起動時刻の確認用。 */
export const pingTool: Tool = {
  name: "aide_ping",
  description:
    "AIDEサーバーへの疎通確認。サーバー時刻・セッションID・稼働中の本体バージョン(serverVersion)・" +
    "プロセスの起動時刻(startedAt, UTC)を返す。AIDEの他のツールが応答しないときの切り分けに使う。" +
    "本番AIDEのバージョン確認や、再起動されたかの確認（startedAtが変わったか）にも使う。" +
    "GitHubの最新リリースや接続登録画面の表示ではなく、実際に応答しているプロセスの値を返す。",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: (_args, ctx) => {
    const info = getProcessInfo();
    return {
      content: [
        {
          type: "text",
          text:
            `pong / time=${new Date().toISOString()} / session=${ctx.sessionId ?? "(なし)"}` +
            ` / serverVersion=${info.version} / startedAt=${info.startedAt}`,
        },
      ],
    };
  },
};
