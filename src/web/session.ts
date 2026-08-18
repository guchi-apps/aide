import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { dirname, join } from "node:path";
import { DATA_DIR } from "../core/paths.ts";

/**
 * 動作状況ページ（`/status`）のログイン状態。
 *
 * **OAuth（`src/auth/`）とは別系統。** あちらはClaudeアプリという機械のための認可で、
 * 動的クライアント登録・PKCE・トークンの発行を伴う。こちらは自分がブラウザで画面を開くための
 * ものなので、同じ枠組みに載せると認可コードの往復が毎回要る。**入力してもらうパスワードは同じ**
 * （`AIDE_AUTH_PASSWORD`）で、利用者が覚えるものを増やさない。
 *
 * Cookieには**署名だけを入れ、状態はサーバーに持たない**。1人しか使わない画面のために
 * セッションの保存先を増やす利点が無く、ファイルに書けば `data/` に消し忘れが溜まる。
 *
 * **署名鍵はパスワードから導かない。** 導くと、Cookieを1つ手に入れた相手がオフラインで
 * パスワードを総当たりでき、`src/auth/ratelimit.ts` の回数制限（オンライン試行にしか効かない）を
 * 迂回されてしまう。しかもそのパスワードはClaudeアプリの接続認可と同じ1本なので、
 * 被害がこの画面の閲覧に留まらない。鍵は独立した乱数を1つ作って保存する。
 *
 * 失効させたいときは鍵のファイルを消す（OAuthのトークンを
 * `rm data/auth/oauth-state.json` で失効させるのと同じ考え方）。
 */

export const SESSION_COOKIE = "aide_status";

/** 有効期間。長すぎると端末を無くしたときに困り、短すぎると開くたびに入力が要る。 */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 署名の用途を混ぜないための接頭辞。
 * 同じ鍵で別の用途の署名を作るときに、片方の署名をもう片方へ持ち込めないようにする。
 */
const PURPOSE = "aide-status-session";

/** 鍵の置き場。中身は実質的な認証情報なので、OAuthの状態と同じ作法で 600 で作る。 */
const KEY_PATH = join(DATA_DIR, "auth", "status-session-key");

let cachedKey: Buffer | null = null;

/**
 * 署名鍵を読む。無ければ作る。
 *
 * 再起動をまたいで残すのは、デプロイのたびにログインし直すのを避けるため。
 * 消せば発行済みのCookieはすべて無効になる。
 */
export async function loadSessionKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey;

  try {
    cachedKey = Buffer.from(await readFile(KEY_PATH, "utf8"), "base64");
    // 空ファイル・壊れた内容で起動すると、署名が事実上無い状態になる。作り直す。
    if (cachedKey.length >= 32) return cachedKey;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }

  const created = randomBytes(32);
  await mkdir(dirname(KEY_PATH), { recursive: true, mode: 0o700 });
  try {
    // "wx" で作る。同時に起動した別プロセスと競合したら、相手が作ったものを読む。
    await writeFile(KEY_PATH, created.toString("base64"), { encoding: "utf8", mode: 0o600, flag: "wx" });
    cachedKey = created;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    cachedKey = Buffer.from(await readFile(KEY_PATH, "utf8"), "base64");
  }
  return cachedKey;
}

/** テスト用。読み込み済みの鍵を捨てる。 */
export function resetSessionKey(): void {
  cachedKey = null;
}

function sign(expiresAt: number, key: Buffer): string {
  return createHmac("sha256", key).update(`${PURPOSE}:${expiresAt}`).digest("base64url");
}

/** Cookieに入れる値。`<失効時刻>.<署名>`。 */
export function issueSession(key: Buffer, now: Date = new Date()): string {
  const expiresAt = now.getTime() + TTL_MS;
  return `${expiresAt}.${sign(expiresAt, key)}`;
}

/** 署名が合っていて期限内なら true。 */
export function verifySession(
  value: string | undefined,
  key: Buffer,
  now: Date = new Date(),
): boolean {
  if (!value) return false;

  const separator = value.lastIndexOf(".");
  if (separator <= 0) return false;

  const expiresAt = Number(value.slice(0, separator));
  // 期限の検査を署名より先に行う。期限切れは署名を照合するまでもなく無効。
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now.getTime()) return false;

  const presented = Buffer.from(value.slice(separator + 1), "utf8");
  const expected = Buffer.from(sign(expiresAt, key), "utf8");
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
 * 付かないようにする。`Secure` はHTTPSで届いたときだけ付ける
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
export function loginCookie(key: Buffer, secure: boolean, now: Date = new Date()): string {
  return sessionCookie(issueSession(key, now), { secure, maxAge: Math.floor(TTL_MS / 1000) });
}

/** ログアウト時に付ける、即座に消えるCookie。 */
export function logoutCookie(secure: boolean): string {
  return sessionCookie("", { secure, maxAge: 0 });
}
