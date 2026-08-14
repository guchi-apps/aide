import { timingSafeEqual } from "node:crypto";

/**
 * 認証の設定。
 *
 * **既定は「認証必須」で、パスワード未設定なら起動を拒否する。**
 * 「あとで入れる」つもりのまま認証なしで公開してしまう事故を、設定ミスではなく
 * 起動失敗として顕在化させるため。無効化するには明示的な指定が要る。
 */

export interface AuthConfig {
  enabled: boolean;
  password: string | null;
}

export function loadAuthConfig(): AuthConfig {
  const password = process.env["AIDE_AUTH_PASSWORD"] ?? "";
  if (password) return { enabled: true, password };

  if (process.env["AIDE_AUTH_DISABLED"] === "1") {
    console.warn(
      "[auth] 警告: 認証が無効です。AIDE_AUTH_DISABLED=1 が指定されています。\n" +
        "[auth] 実データを返すサーバーを公開する場合は、必ず AIDE_AUTH_PASSWORD を設定してください。",
    );
    return { enabled: false, password: null };
  }

  throw new Error(
    "AIDE_AUTH_PASSWORD が未設定です。認証なしで起動する場合は AIDE_AUTH_DISABLED=1 を明示してください。",
  );
}

/** パスワード照合。長さの違いで早期returnしないよう、常に同じ経路を通す。 */
export function verifyPassword(input: string, expected: string): boolean {
  const a = Buffer.from(input, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    // 長さが違っても比較自体は行い、処理時間から長さを推測されにくくする。
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * 公開URL。Apacheやcloudflaredの背後にいるため、リクエストのHostから組み立てる。
 * OAuthのメタデータに載せるURLがずれると、クライアントが別のホストへ飛んで認証が壊れる。
 */
export function resolveBaseUrl(headers: NodeJS.Dict<string | string[]>): string {
  const configured = process.env["AIDE_BASE_URL"];
  if (configured) return configured.replace(/\/$/, "");

  const host = String(headers["x-forwarded-host"] ?? headers["host"] ?? "localhost");
  const proto = String(headers["x-forwarded-proto"] ?? "https");
  return `${proto}://${host}`;
}
