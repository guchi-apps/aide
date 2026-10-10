import { DEV_AUTH_DISABLED_CLIENT_ID } from "../types.ts";
import type { Tool } from "../types.ts";

/** 有無を明示して返すscope。未許可と判定不能を混同しないよう、`scopes` が配列のときだけ判定する。 */
const CHECKED_SCOPES = [
  "tasks:read",
  "tasks:write",
  "work-reports:read",
  "work-reports:write",
] as const;

/**
 * 現在の接続（このリクエストの認証結果）に付与されたscopeの診断（#629）。
 * 読み取り専用で、どのscopeも要求しない（書き込み権限が無い接続でも自分の権限を確かめられるように）。
 * 入力は取らない。別接続・任意ユーザーの権限は見せない。トークンやclientIdは返さない。
 */
export const connectionPermissionsTool: Tool = {
  name: "aide_connection_permissions",
  description:
    "読み取り専用の接続診断。いまこのMCP接続に付与されているOAuth scope（tasks:read・tasks:write・" +
    "work-reports:read・work-reports:write）の有無を、このリクエストの認証結果から返す。" +
    "「work-reports:writeが許可されているか」の確認に使う。書き込みの試し打ちは不要。" +
    "authMode=auth-disabled は開発用の認証無効起動で、OAuthの付与ではない。" +
    "scopeを判定できないときは未許可とせずエラーで返す。サーバーの対応scope一覧や別接続の権限は返さない。",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: (_args, ctx) => {
    const authMode = ctx.clientId === DEV_AUTH_DISABLED_CLIENT_ID ? "auth-disabled" : "oauth";
    if (!Array.isArray(ctx.scopes)) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "indeterminate",
              authMode,
              message: "この接続のscopeを判定できませんでした。未許可とは限りません。",
            }),
          },
        ],
        isError: true,
      };
    }
    const scopes = [...ctx.scopes];
    const checks = Object.fromEntries(CHECKED_SCOPES.map((s) => [s, scopes.includes(s)]));
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "ok",
            authMode,
            scopes,
            checks,
            note:
              authMode === "auth-disabled"
                ? "開発用の認証無効モード。全scopeを仮置きしており、OAuthで付与された権限ではありません。"
                : "このリクエストの認証結果に基づく付与済みscopeです。",
          }),
        },
      ],
    };
  },
};
