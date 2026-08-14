import type { Tool } from "../types.ts";

/** 疎通確認用。AIDE本体の機能ではないが、接続トラブル時の切り分けに要る。 */
export const pingTool: Tool = {
  name: "aide_ping",
  description:
    "AIDEサーバーへの疎通確認。サーバー時刻とセッションIDを返す。" +
    "AIDEの他のツールが応答しないときの切り分けに使う。それ以外の用途はない。",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: (_args, ctx) => ({
    content: [
      {
        type: "text",
        text: `pong / time=${new Date().toISOString()} / session=${ctx.sessionId ?? "(なし)"}`,
      },
    ],
  }),
};
