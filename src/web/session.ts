import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/**
 * 動作状況ページ（`/status`）のログイン状態。
 *
 * **OAuth（`src/auth/`）とは別系統。** あちらはClaudeアプリという機械のための認可で、
 * 動的クライアント登録・PKCE・トークンの発行を伴う。こちらは自分がブラウザで画面を開くための
 * ものなので、同じ枠組みに載せると認可コードの往復が毎回要る。照合するパスワードは同じ
 * （`AIDE_AUTH_PASSWORD`）で、利用者が覚えるものを増やさない。
 *
 * Cookieには**署名だけを入れ、状態はサーバーに持たない**。1人しか使わない画面のために
 * セッションの保存先を増やす利点が無く、ファイルに書けば `data/` に消し忘れが溜まる。
 *
 * 鍵はパスワードそのものから導く。パスワードを変えれば発行済みのCookieは自動的に無効になる
 * （OAuthのトークンが `data/auth/oauth-state.json` の削除で失効するのと同じ考え方）。
 */

export const SESSION_COOKIE = "aide_status";

/** 有効期間。長すぎると端末を無くしたときに困り、短すぎると開くたびに入力が要る。 */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 署名の用途を混ぜないための接頭辞。
 * 同じ鍵で別の用途の署名を作るときに、片方の署名をもう片方へ持ち込めないようにする。
 */
const PURPOSE = "aide-status-session";

function sign(expiresAt: number, password: string): string {
  return createHmac("sha256", password).update(`${PURPOSE}:${expiresAt}`).digest("base64url");
}

/** Cookieに入れる値。`<失効時刻>.<署名>`。 */
export function issueSession(password: string, now: Date = new Date()): string {
  const expiresAt = now.getTime() + TTL_MS;
  return `${expiresAt}.${sign(expiresAt, password)}`;
}

/** 署名が合っていて期限内なら true。 */
export function verifySession(
  value: string | undefined,
  password: string,
  now: Date = new Date(),
): boolean {
  if (!value) return false;

  const separator = value.lastIndexOf(".");
  if (separator <= 0) return false;

  const expiresAt = Number(value.slice(0, separator));
  // 期限の検査を署名より先に行う。期限切れは署名を照合するまでもなく無効。
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now.getTime()) return false;

  const presented = Buffer.from(value.slice(separator + 1), "utf8");
  const expected = Buffer.from(sign(expiresAt, password), "utf8");
  // 長さが違っても比較自体は行い、処理時間から情報を与えない（auth/config.ts と同じ）。
  if (presented.length !== expected.length) {
    timingSafeEqual(expected, expected);
    return false;
  }
  return timingSafeEqual(presented, expected);
}

/** リクエストのCookieヘッダを読む。壊れた値は無視する。 */
export function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * `Set-Cookie` の値。
 *
 * `HttpOnly` でJavaScriptから読めないようにし、`SameSite=Lax` で他サイトからのPOSTに
 * 付かないようにする。`Secure` は公開URLがHTTPSのときだけ付ける
 * （開発機は `http://localhost` で、常に付けるとログインできない）。
 */
export function sessionCookie(value: string, options: { secure: boolean; maxAge: number }): string {
  const attributes = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${options.maxAge}`,
  ];
  if (options.secure) attributes.push("Secure");
  return attributes.join("; ");
}

/** ログイン直後に付けるCookie。 */
export function loginCookie(password: string, secure: boolean, now: Date = new Date()): string {
  return sessionCookie(issueSession(password, now), { secure, maxAge: Math.floor(TTL_MS / 1000) });
}

/** ログアウト時に付ける、即座に消えるCookie。 */
export function logoutCookie(secure: boolean): string {
  return sessionCookie("", { secure, maxAge: 0 });
}
