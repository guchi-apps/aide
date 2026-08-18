import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { dirname, join } from "node:path";
import { DATA_DIR } from "../core/paths.ts";

/**
 * 動作状況ページ（`/status`）のログイン状態。
 *
 * **OAuth（`src/auth/oauth.ts`）とは別系統。** あちらはClaudeアプリという機械のための認可で、
 * 動的クライアント登録・PKCE・トークンの発行を伴う。こちらは自分がブラウザで画面を開くための
 * ものなので、同じ枠組みに載せると認可コードの往復が毎回要る。
 *
 * **ログインの手段は2通りあるが、発行するCookieは1種類。** Googleログイン
 * （`src/auth/supabase.ts`。設定されていればこちらだけ）ならログインした人のメールアドレスを、
 * 従来のパスワード（Google未設定の環境）なら身元なしを表す `null` を入れる。
 * 画面はこのCookieだけを見るので、どちらで入ったかを気にしなくてよい。
 *
 * Cookieには**署名だけを入れ、状態はサーバーに持たない**。1人しか使わない画面のために
 * セッションの保存先を増やす利点が無く、ファイルに書けば `data/` に消し忘れが溜まる。
 * **メールアドレスも署名の対象に含める。** 含めないと、署名だけ合っている値の
 * メールアドレス欄を書き換えて、許可されていない身元を名乗れてしまう。
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

function sign(purpose: string, parts: string[], key: Buffer): string {
  return createHmac("sha256", key).update([purpose, ...parts].join(":")).digest("base64url");
}

/** 署名を照合する。長さが違っても比較自体は行い、処理時間から情報を与えない（auth/config.ts と同じ）。 */
function signatureMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * 署名付きの値を読む。`<失効時刻>.<本体…>.<署名>` の形だけを受け付ける。
 * 本体の個数（`fields`）が合わない値は、そもそも別の用途の値として弾く。
 */
function readSigned(
  value: string | undefined,
  key: Buffer,
  purpose: string,
  fields: number,
  now: Date,
): string[] | null {
  if (!value) return null;

  const parts = value.split(".");
  if (parts.length !== fields + 2) return null;

  const expiresAt = Number(parts[0]);
  // 期限の検査を署名より先に行う。期限切れは署名を照合するまでもなく無効。
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now.getTime()) return null;

  const body = parts.slice(1, -1);
  if (!signatureMatches(parts.at(-1)!, sign(purpose, [String(expiresAt), ...body], key))) return null;
  return body;
}

/** ログインしている人。Googleログインならメールアドレス、パスワードでのログインなら `null`。 */
export interface StatusSession {
  email: string | null;
}

/**
 * Cookieに入れる値。`<失効時刻>.<メールアドレス>.<署名>`。
 *
 * メールアドレスは `.` を含みうるので base64url にしてから並べる
 * （区切りが増えると、どこまでが本体か決められなくなる）。
 */
export function issueSession(key: Buffer, email: string | null, now: Date = new Date()): string {
  const expiresAt = now.getTime() + TTL_MS;
  const encoded = Buffer.from(email ?? "", "utf8").toString("base64url");
  return `${expiresAt}.${encoded}.${sign(PURPOSE, [String(expiresAt), encoded], key)}`;
}

/** 署名が合っていて期限内なら、その中身を返す。通らなければ `null`。 */
export function readSession(
  value: string | undefined,
  key: Buffer,
  now: Date = new Date(),
): StatusSession | null {
  const body = readSigned(value, key, PURPOSE, 1, now);
  if (!body) return null;
  const email = Buffer.from(body[0]!, "base64url").toString("utf8");
  return { email: email || null };
}

// ---- Googleログインの往復（`src/auth/supabase.ts`）----

/**
 * 認可の往復のあいだだけ持つCookie。
 *
 * **サーバー側に置かない。** 状態を持たない方針は同じで、しかも1往復で捨てる値のために
 * 保存先を作ると消し忘れが溜まる。`state` は「戻ってきた認可コードが自分の始めた
 * ログインのものか」を確かめるため、`verifier`（PKCE）は認可コードを拾った第三者に
 * 交換させないために要る。
 */
export const HANDSHAKE_COOKIE = "aide_status_login";

const HANDSHAKE_PURPOSE = "aide-status-login";

/** 認可の往復に許す時間。同意画面で迷っても足り、放置された値は自然に無効になる長さ。 */
const HANDSHAKE_TTL_MS = 10 * 60 * 1000;

export interface Handshake {
  state: string;
  verifier: string;
}

export function issueHandshake(key: Buffer, handshake: Handshake, now: Date = new Date()): string {
  const expiresAt = now.getTime() + HANDSHAKE_TTL_MS;
  const parts = [String(expiresAt), handshake.state, handshake.verifier];
  return `${parts.join(".")}.${sign(HANDSHAKE_PURPOSE, parts, key)}`;
}

export function readHandshake(
  value: string | undefined,
  key: Buffer,
  now: Date = new Date(),
): Handshake | null {
  const body = readSigned(value, key, HANDSHAKE_PURPOSE, 2, now);
  if (!body) return null;
  return { state: body[0]!, verifier: body[1]! };
}

/** 戻ってきた `state` が、こちらが始めたログインのものか。 */
export function stateMatches(presented: string, expected: string): boolean {
  return signatureMatches(presented, expected);
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
export function cookie(
  name: string,
  value: string,
  options: { secure: boolean; maxAge: number },
): string {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${options.maxAge}`,
  ];
  if (options.secure) attributes.push("Secure");
  return attributes.join("; ");
}

export function sessionCookie(value: string, options: { secure: boolean; maxAge: number }): string {
  return cookie(SESSION_COOKIE, value, options);
}

/** ログイン直後に付けるCookie。 */
export function loginCookie(
  key: Buffer,
  options: { secure: boolean; email: string | null },
  now: Date = new Date(),
): string {
  return sessionCookie(issueSession(key, options.email, now), {
    secure: options.secure,
    maxAge: Math.floor(TTL_MS / 1000),
  });
}

/** ログアウト時に付ける、即座に消えるCookie。 */
export function logoutCookie(secure: boolean): string {
  return sessionCookie("", { secure, maxAge: 0 });
}

/** Googleへ送り出すときに付けるCookie。 */
export function handshakeCookie(key: Buffer, handshake: Handshake, secure: boolean): string {
  return cookie(HANDSHAKE_COOKIE, issueHandshake(key, handshake), {
    secure,
    maxAge: Math.floor(HANDSHAKE_TTL_MS / 1000),
  });
}

/** 戻ってきた時点で用済みなので消す。**成否によらず必ず消す**（使い回させない）。 */
export function clearHandshakeCookie(secure: boolean): string {
  return cookie(HANDSHAKE_COOKIE, "", { secure, maxAge: 0 });
}
