import type { Tool, ToolResult } from "../types.ts";

/**
 * Zaimへの支出登録（aide#135）とマスタの一覧。**Zaim公式APIの終了に伴い廃止した（aide#714）。**
 *
 * どちらもZaim公式API（OAuth 1.0a）で動いていた。公式APIは2026-12-07に全エンドポイントが停止し、
 * 後継APIは提供されない。Web版の画面を操作する経路（`/api/zaim/payment/web`）は分類を
 * 名前で受け取り、口座・分類の一覧を返す手段も持たないため、この2ツールの付け替え先にはしなかった
 * （判断の記録は `docs/zaim-api-shutdown.md`）。
 *
 * **ツールそのものは残し、廃止の理由と代わりの手段を返す。** カタログから消すと、Claudeには
 * 「ツールが無い」としか見えず、なぜ登録できないのかが利用者へ伝わらない。
 */

export const ZAIM_API_RETIRED_REASON =
  "Zaim公式APIの提供終了（2026-12-07）に伴い、この機能は廃止しました（aide#714）。Zaimへは何も問い合わせていません。";

function retired(alternative: string): ToolResult {
  return {
    content: [
      { type: "text", text: JSON.stringify({ ok: false, kind: "retired", reason: ZAIM_API_RETIRED_REASON, alternative }, null, 2) },
    ],
    // 状態として返す。isError にすると Claude が同じ内容で再試行するだけになる。
    isError: false,
  };
}

export const zaimMasterTool: Tool = {
  name: "aide_zaim_master",
  description:
    "【廃止】Zaim公式APIの提供終了に伴い廃止した。呼んでも口座・カテゴリ・ジャンルの一覧は返らず、廃止の理由だけを返す。",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async () => retired("口座・カテゴリ・ジャンルはZaimのアプリ・Web版の画面で確認してください。"),
};

export const zaimPaymentTool: Tool = {
  name: "aide_zaim_payment",
  description:
    "【廃止】Zaim公式APIの提供終了に伴い廃止した。呼んでもZaimへは登録されず、廃止の理由だけを返す。" +
    "支出の記録を頼まれたら、Zaimのアプリ・Web版の画面から登録するよう利用者へ伝える。",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async () => retired("Zaimのアプリ・Web版の画面から登録してください。"),
};
