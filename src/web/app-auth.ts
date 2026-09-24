import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * iOSアプリのWeb認証からWKWebViewへ、画面用Cookieを直接見せずに引き継ぐ。
 *
 * カスタムURLスキームへ返すのは短寿命・一回限りの不透明なコードだけ。さらにiOSが
 * ログイン開始前に作ったPKCE verifierを交換時に要求し、別アプリがコードを拾っても
 * 使えないようにする。画面用Cookieそのものは `src/web/login.ts` がHTTPSのPOST応答で
 * WKWebViewへ直接発行する。
 */
export const APP_CALLBACK_URL = "com.gucchii.aide:/auth/callback";

const HANDOFF_TTL_MS = 2 * 60 * 1000;
const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

/**
 * 引き継ぎの用途。**用途が違うコードは交換できない。**
 * `web` は画面用Cookie（WKWebView）、`mobile` は室温などを読むネイティブ向けトークン。
 * 交換口を分けても、コードの側に用途が無いと「Web用に発行したコードでトークンを取る」ことができてしまう。
 */
export type AppHandoffPurpose = "web" | "mobile";

interface StoredAppHandoff {
  email: string;
  next: string;
  challenge: string;
  purpose: AppHandoffPurpose;
  expiresAt: number;
}

export interface AppHandoff {
  email: string;
  next: string;
}

const handoffs = new Map<string, StoredAppHandoff>();

function prune(now: number): void {
  for (const [code, handoff] of handoffs) {
    if (handoff.expiresAt <= now) handoffs.delete(code);
  }
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

function valueMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "ascii");
  const b = Buffer.from(expected, "ascii");
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** iOSが送ったS256 challengeとして受け付ける形か。 */
export function isAppChallenge(value: string | null | undefined): value is string {
  return typeof value === "string" && S256_CHALLENGE.test(value);
}

/** Googleログイン完了後に、短寿命・一回限りの交換コードを発行する。 */
export function issueAppHandoff(
  input: { email: string; next: string; challenge: string; purpose?: AppHandoffPurpose },
  now: number = Date.now(),
): string {
  if (!isAppChallenge(input.challenge)) throw new Error("invalid app PKCE challenge");

  prune(now);
  const code = randomBytes(32).toString("base64url");
  handoffs.set(code, {
    email: input.email,
    next: input.next,
    challenge: input.challenge,
    purpose: input.purpose ?? "web",
    expiresAt: now + HANDOFF_TTL_MS,
  });
  return code;
}

/**
 * コードを取り出して即座に削除する。verifierが違う場合も復活させないため、
 * 同じコードは成否にかかわらず二度目には使えない。
 */
export function consumeAppHandoff(
  code: string,
  verifier: string,
  purpose: AppHandoffPurpose = "web",
  now: number = Date.now(),
): AppHandoff | null {
  const found = handoffs.get(code);
  if (!found) return null;
  handoffs.delete(code);

  if (found.purpose !== purpose) return null;
  if (found.expiresAt <= now || !PKCE_VERIFIER.test(verifier)) return null;
  if (!valueMatches(s256(verifier), found.challenge)) return null;
  return { email: found.email, next: found.next };
}

/** ASWebAuthenticationSessionだけが受け取る固定の戻り先。 */
export function appCallbackUrl(result: { code?: string; error?: string }): string {
  const url = new URL(APP_CALLBACK_URL);
  if (result.code) url.searchParams.set("code", result.code);
  if (result.error) url.searchParams.set("error", result.error);
  return url.toString();
}

/** テスト用。プロセス内の未交換コードを捨てる。 */
export function resetAppHandoffs(): void {
  handoffs.clear();
}
