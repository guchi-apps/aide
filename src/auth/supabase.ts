import { createHash, randomBytes } from "node:crypto";

/**
 * 動作状況ページ（`/status`）のGoogleログイン。
 *
 * **MCPのOAuth（`src/auth/oauth.ts`）とは別系統。** あちらはClaudeアプリという機械を
 * このサーバーへ接続させるための認可で、利用者の身元は問わない（パスワード1本）。
 * こちらは「画面を開いてよい人か」を確かめるためのもので、身元＝メールアドレスを見る。
 *
 * 認証基盤は他のアプリ（dayspan・shopping-list）と同じ共有Supabaseプロジェクトを使う。
 * Googleのクライアント登録・同意画面・トークンの扱いはSupabase側に既にあり、
 * このリポジトリのためだけにGoogle Cloud Consoleへもう1つ作る理由が無い。
 *
 * **`@supabase/supabase-js` は入れない。** このリポジトリは実行時依存ゼロで、素の
 * `node:http` で動いている（README）。必要なのは認可URLの組み立てとコードの交換だけなので、
 * Auth の REST（`/auth/v1/authorize` と `/auth/v1/token?grant_type=pkce`）を fetch で直接叩く。
 * 他のアプリがクライアントライブラリ経由なのはNext.jsのCookie連携が要るためで、
 * ここではセッションを自前のCookie（`src/web/session.ts`）に持つため要らない。
 *
 * **Supabaseのセッションは保持しない。** 受け取るのはログインした瞬間の身元だけで、
 * それを確かめたらSupabase側のセッションは失効させ、以降は自前のCookieだけで通す。
 * アクセストークンを持ち回ると、画面を開くためだけの仕組みが認証基盤の資格情報を
 * 抱えることになる。
 */

export interface SupabaseAuthConfig {
  /** プロジェクトのURL。末尾のスラッシュは落としてある。 */
  url: string;
  /** ブラウザへ出しても構わない公開鍵（旧 anon key）。Auth REST の `apikey` に要る。 */
  publishableKey: string;
  /** 画面を開いてよいメールアドレス。小文字化・重複排除済みで、**空にはならない**。 */
  allowedEmails: string[];
}

const ENV_URL = "AIDE_SUPABASE_URL";
const ENV_KEY = "AIDE_SUPABASE_PUBLISHABLE_KEY";
const ENV_EMAILS = "AIDE_STATUS_ALLOWED_EMAILS";

/** コールバックのパス。Supabaseダッシュボードの Redirect URLs にも同じものを登録する。 */
export const CALLBACK_PATH = "/status/auth/callback";

/** 外部への問い合わせが返らないまま画面が固まらないようにする。 */
const REQUEST_TIMEOUT_MS = 10_000;

export function parseAllowedEmails(raw: string | undefined): string[] {
  return [
    ...new Set(
      (raw ?? "")
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

/**
 * 設定を読む。3つとも未設定なら `null`（＝Googleログインを使わず、従来のパスワードで開く）。
 *
 * **半端に設定された状態は起動失敗にする。** 特に許可メールだけが抜けた状態は、
 * 「Googleでログインできる誰でも」が画面を開ける状態になる。`AIDE_AUTH_PASSWORD` を
 * 未設定なら起動させない（`src/auth/config.ts`）のと同じ考え方で、設定ミスを
 * 実行時の穴ではなく起動時の失敗として顕在化させる。
 */
export function loadSupabaseAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): SupabaseAuthConfig | null {
  const url = (env[ENV_URL] ?? "").trim().replace(/\/+$/, "");
  const publishableKey = (env[ENV_KEY] ?? "").trim();
  const allowedEmails = parseAllowedEmails(env[ENV_EMAILS]);

  const missing = [
    url ? "" : ENV_URL,
    publishableKey ? "" : ENV_KEY,
    allowedEmails.length ? "" : ENV_EMAILS,
  ].filter(Boolean);

  if (missing.length === 3) return null;
  if (missing.length > 0) {
    throw new Error(
      `動作状況ページのGoogleログインの設定が足りません: ${missing.join(", ")}。` +
        "3つすべてを設定するか、3つとも未設定にしてください（未設定ならパスワードでのログインになります）。",
    );
  }

  try {
    new URL(url);
  } catch {
    throw new Error(`${ENV_URL} がURLとして読めません。`);
  }

  return { url, publishableKey, allowedEmails };
}

/** 画面を開いてよいメールアドレスか。大文字小文字は区別しない。 */
export function isAllowedEmail(email: string | null | undefined, config: SupabaseAuthConfig): boolean {
  if (!email) return false;
  return config.allowedEmails.includes(email.trim().toLowerCase());
}

// ---- 認可の開始 ----

export interface Pkce {
  verifier: string;
  challenge: string;
}

/**
 * PKCE（S256）の組。
 *
 * Supabaseの認可コードは「コールバックのURLに載って戻ってくる」ため、リファラや履歴から
 * 拾われうる。検証値を知らないと交換できないようにしておく。
 */
export function createPkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function authorizeUrl(
  config: SupabaseAuthConfig,
  options: { redirectUri: string; challenge: string },
): string {
  const url = new URL("/auth/v1/authorize", config.url);
  url.searchParams.set("provider", "google");
  url.searchParams.set("redirect_to", options.redirectUri);
  url.searchParams.set("code_challenge", options.challenge);
  // Supabase は小文字の s256 を期待する（大文字だと invalid_request になる）。
  url.searchParams.set("code_challenge_method", "s256");
  return url.toString();
}

// ---- 認可コードの交換 ----

export interface SignedInUser {
  email: string;
  /** Supabase側のセッションを失効させるためだけに持つ。保存はしない。 */
  accessToken: string;
}

interface TokenResponse {
  access_token?: unknown;
  user?: { email?: unknown; user_metadata?: { email_verified?: unknown } };
}

/**
 * 認可コードをSupabaseで交換し、ログインした人のメールアドレスを得る。
 * 失敗の理由は呼び出し側でログにだけ出す（画面へは出さない）。
 */
export async function exchangeCode(
  config: SupabaseAuthConfig,
  options: { code: string; verifier: string },
): Promise<SignedInUser> {
  const endpoint = new URL("/auth/v1/token", config.url);
  endpoint.searchParams.set("grant_type", "pkce");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: config.publishableKey,
      Authorization: `Bearer ${config.publishableKey}`,
    },
    body: JSON.stringify({ auth_code: options.code, code_verifier: options.verifier }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Supabaseが認可コードの交換を拒否した (HTTP ${response.status})`);
  }

  const body = (await response.json()) as TokenResponse;
  const email = typeof body.user?.email === "string" ? body.user.email : "";
  if (!email) throw new Error("Supabaseの応答にメールアドレスが含まれていない");

  // Googleでログインした場合は常に確認済みだが、将来ほかの経路が有効になったときに
  // 未確認のアドレスが許可リストと一致してしまわないよう、明示的に否定されたら拒む。
  if (body.user?.user_metadata?.email_verified === false) {
    throw new Error("メールアドレスが確認されていない");
  }

  return { email, accessToken: typeof body.access_token === "string" ? body.access_token : "" };
}

/**
 * Supabase側のセッションを失効させる。**失敗しても呼び出し側は続行してよい。**
 * こちらの画面の可否は自前のCookieだけで決まるため、失効漏れが権限になることはない。
 */
export async function revokeSession(config: SupabaseAuthConfig, accessToken: string): Promise<void> {
  if (!accessToken) return;
  try {
    await fetch(new URL("/auth/v1/logout", config.url), {
      method: "POST",
      headers: { apikey: config.publishableKey, Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    console.warn("[status] Supabaseのセッション失効に失敗", cause);
  }
}
