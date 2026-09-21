import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthConfig } from "../auth/config.ts";
import { verifyPassword } from "../auth/config.ts";
import { clientKey, FAILURE_DELAY_MS, lockedFor, recordFailure, recordSuccess } from "../auth/ratelimit.ts";
import {
  authorizeUrl,
  callbackUrl,
  createPkce,
  exchangeCode,
  isAllowedEmail,
  revokeSession,
  type SupabaseAuthConfig,
} from "../auth/supabase.ts";
import type { ToolRegistry } from "../mcp/registry.ts";
import {
  appCallbackUrl,
  consumeAppHandoff,
  isAppChallenge,
  issueAppHandoff,
} from "./app-auth.ts";
import { brandHtml, escapeHtml, isSiteNavPath, renderPage, siteNavLabel } from "./layout.ts";
import {
  clearHandshakeCookie,
  handshakeCookie,
  HANDSHAKE_COOKIE,
  loadSessionKey,
  loginCookie,
  logoutCookie,
  readCookie,
  readHandshake,
  readSession,
  SESSION_COOKIE,
  stateMatches,
  type StatusSession,
} from "./session.ts";

/**
 * 画面のログイン。ログインの内側にある画面（アプリ連携 `/map`・機能一覧 `/features`）の関門を
 * ここ1か所で持つ。
 *
 * **受け口のパスが `/status/...` のままなのは、Supabaseに登録した戻り先を変えないため。**
 * 以前はここに動作状況の画面（`GET /status`）があり、ログインはその付属だった。画面そのものは
 * ops-dashboard の「AIDE」タブへ役目を譲って外した（#328）が、戻り先 `/status/auth/callback`
 * はSupabaseダッシュボードの許可リストに載っており、変えると手作業での登録し直しが要る。
 * Cookie名（`aide_status`）も同じ理由で据え置いている。
 *
 * **ログインの手段は設定で決まる。** Supabaseの設定（`src/auth/supabase.ts`）があれば
 * 許可したメールアドレスだけが通るGoogleログイン、無ければ従来のパスワードになる。
 * **併存はさせない。** パスワードを残したままにすると、「特定のメールアドレスの人しか
 * 開けない」という制限をパスワード1本で迂回できてしまう。
 */

const TITLE = "AIDE にログイン";

/** フォームの受け口。**パスワード1つしか受け取らない**ので、上限は小さくてよい。 */
const MAX_FORM_BYTES = 4096;

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // 際限なく受け取ると、認証前のエンドポイントでメモリを使い切らせる材料になる。
    if (size > MAX_FORM_BYTES) throw new Error("送信されたデータが大きすぎます");
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

export interface LoginOptions {
  authConfig: AuthConfig;
  /** Googleログインの設定。`null` なら従来のパスワードでのログインになる。 */
  supabase: SupabaseAuthConfig | null;
  baseUrl: string;
  registry: ToolRegistry;
}

/**
 * このリクエストがHTTPSで届いたか。Cookie に `Secure` を付けるかの判断に使う。
 *
 * **`resolveBaseUrl()` の結果では判断できない。** あちらは転送ヘッダが無いときHTTPSを
 * 既定にしており（OAuthのメタデータに載せるURLがHTTPになると認証が壊れるため）、
 * その値を使うと開発機の `http://localhost` でも `Secure` が付く。
 *
 * Apache や cloudflared の背後では `X-Forwarded-Proto` が付く。付いていないのは
 * Nodeへ直接届いた場合＝TLSを終端していない場合なので、公開URLの設定だけを見る。
 */
function isSecure(req: IncomingMessage): boolean {
  const forwarded = req.headers["x-forwarded-proto"];
  if (forwarded) {
    const first = (Array.isArray(forwarded) ? forwarded[0]! : forwarded).split(",")[0];
    return first?.trim() === "https";
  }
  return (process.env["AIDE_BASE_URL"] ?? "").startsWith("https://");
}

/**
 * いまログインしている人。ログインしていなければ `null`。
 *
 * **認証が無効な環境（`AIDE_AUTH_DISABLED=1`）では素通しする。** MCPも `/api` も
 * 素通しになっている状態でこの画面だけログインを求めても、守るものが無い。
 * その場合は画面自身が「認証が無効」と警告を出す（`src/web/map.ts`）。
 *
 * **許可リストはCookieを出すときだけでなく、開くたびに照合する。** リストから外した
 * アドレスが、発行済みのCookieの有効期間（7日）だけ入れ続けられるのを避ける。
 *
 * ログインの内側に画面を足すときも、必ずこの関門を通す。**画面ごとに判定を書かない。**
 * 片方だけ条件が古くなると、そこが素通しの入口になる。
 */
export async function currentSession(
  req: IncomingMessage,
  options: LoginOptions,
): Promise<StatusSession | null> {
  if (!options.authConfig.enabled) return { email: null };

  const session = readSession(readCookie(req, SESSION_COOKIE), await loadSessionKey());
  if (!session) return null;
  if (options.supabase && !isAllowedEmail(session.email, options.supabase)) return null;
  return session;
}

const ACCOUNT_MENU_ID = "account-menu";

const ICON_USER = `<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8.2" r="3.9" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M4.4 20.2c.6-3.6 3.7-5.6 7.6-5.6s7 2 7.6 5.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`;
const ICON_LOGOUT = `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 4.5H6.2a1.7 1.7 0 0 0-1.7 1.7v11.6a1.7 1.7 0 0 0 1.7 1.7h3.3M15 8l4 4-4 4M19 12H9.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/**
 * ヘッダー右上のアカウントボタンと、押すと開くメニュー（ログイン中のメールアドレスとログアウト）。
 * 認証が無効な環境では何も出さない（ログアウトしても素通しのままで、押す意味が無い）。
 *
 * 開閉はブラウザ標準のポップオーバー（`popover`）に任せ、JavaScriptは足さない。
 * 外側を押す・Escキー・もう一度ボタンを押すで閉じる処理と、開閉状態の読み上げはブラウザが持つ。
 * 位置決めのCSSは `src/web/layout.ts` の `.account-menu`。
 */
export function accountAction(session: StatusSession | null, authEnabled: boolean): string {
  if (!authEnabled) return "";
  const who = session?.email
    ? `<div class="account-who"><span class="lb">ログイン中</span><span class="em">${escapeHtml(session.email)}</span></div>`
    : "";
  return `<div class="account"><button class="account-btn" type="button" popovertarget="${ACCOUNT_MENU_ID}" aria-label="アカウント" aria-haspopup="true">${ICON_USER}</button>
<div id="${ACCOUNT_MENU_ID}" class="account-menu" popover="auto" role="group" aria-label="アカウント">${who}<form method="post" action="/status/logout"><button class="account-out" type="submit">${ICON_LOGOUT}ログアウト</button></form></div></div>`;
}

/**
 * ログイン画面。`google` が true なら「Googleでログイン」だけを出す。
 *
 * **Googleログインが有効なときにパスワード欄を残さない。** 残すと、許可した
 * メールアドレスに絞った意味がパスワード1本で消える。
 */
export function renderLoginPage(options: {
  google: boolean;
  error?: string;
  /**
   * ログイン後に戻る画面。**開こうとした画面をここへ入れる。**
   * ログインの内側の画面が複数になったとき、直接開いた画面へ戻れるようにするためのもの。
   */
  next?: string;
}): string {
  const error = options.error ? `<p class="err">${escapeHtml(options.error)}</p>` : "";
  const next = safeLanding(options.next);
  // 開こうとした画面の名前を見出しにする。名前が引けなければ既定の画面（アプリ連携）の名前になる。
  const heading = `${siteNavLabel(next) ?? "アプリ連携"}を見る`;

  const body = options.google
    ? `<div class="box">
${brandHtml()}
<h1>${escapeHtml(heading)}</h1>
<p>許可されたGoogleアカウントだけが開けます。</p>
${error}
<a class="signin" href="/status/auth/start?next=${encodeURIComponent(next)}">Googleでログイン</a>
</div>`
    : `<form class="box" method="post" action="/status/login">
${brandHtml()}
<h1>${escapeHtml(heading)}</h1>
<p>Claudeアプリの接続に使うパスワードと同じです。</p>
<input type="hidden" name="next" value="${escapeHtml(next)}">
<label>パスワード<input type="password" name="password" autofocus required autocomplete="current-password"></label>
${error}
<button type="submit">開く</button>
<p>5回間違えると15分ロックされます。</p>
</form>`;

  return renderPage({ title: TITLE, centered: true, body });
}

// ---- ハンドラ ----

function html(
  res: ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string | string[]> = {},
): void {
  res
    .writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...headers })
    .end(body);
}

/**
 * ログインの内側の画面を返す。**ログインの内側に画面を足すときは、必ずここを通す。**
 * 未ログインなら `path` へ戻る前提のログイン画面を、ログイン済みなら `render` の結果を返す。
 * 画面ごとに `currentSession` の判定を書くと、片方だけ条件が古くなって素通しの入口になる。
 */
export async function handleGatedPage(
  req: IncomingMessage,
  res: ServerResponse,
  options: LoginOptions,
  path: string,
  render: (session: StatusSession) => string,
): Promise<void> {
  const session = await currentSession(req, options);
  html(res, 200, session ? render(session) : renderLoginPage({ google: options.supabase !== null, next: path }));
}

/** ログイン後の既定の戻り先。 */
export const DEFAULT_LANDING = "/map";

/**
 * ログイン後に戻る画面。**既知の画面でなければ既定へ落とす。**
 *
 * 戻り先はフォームの hidden とCookieで運ぶ。署名やフォームが保証するのは「AIDEが出した
 * 画面から来たこと」までで、値そのものは利用者の手を通る。外部URLをそのまま `Location`
 * に載せると、ログイン直後に別サイトへ送り出す踏み台になる。
 */
export function safeLanding(value: string | null | undefined): string {
  return isSiteNavPath(value) ? value! : DEFAULT_LANDING;
}

/** 設定上そのエンドポイントが存在しない場合。サーバーの既定の404と同じ見た目にする。 */
function notFound(res: ServerResponse): void {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not found\n");
}

// ---- Googleログイン ----

/**
 * Googleへ送り出す。**素のリンクで踏めるようにGETで受ける。**
 * ボタンのJavaScriptに依存させると、スクリプトが動かない環境で押しても何も起きない
 * （guchi-apps/docs の knowledge/supabase.md）。
 */
async function beginStatusAuth(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: LoginOptions,
  appChallenge?: string,
): Promise<void> {
  const config = options.supabase;
  if (!config) {
    notFound(res);
    return;
  }

  const { verifier, challenge } = createPkce();
  const state = randomBytes(16).toString("base64url");
  // 開こうとした画面を往復のあいだ持ち回る。値の検証は戻ってきたときにも行う。
  const next = safeLanding(url.searchParams.get("next"));

  // 戻り先に state を載せる。Supabaseは redirect_to のクエリをそのまま残して戻す。
  // 組み立ては callbackUrl() に寄せてある（検証と同じ形にするため。src/auth/redirect-check.ts）。
  const redirect = callbackUrl(options.baseUrl, state);

  res
    .writeHead(302, {
      Location: authorizeUrl(config, { redirectUri: redirect, challenge }),
      "Set-Cookie": handshakeCookie(
        await loadSessionKey(),
        { state, verifier, next, ...(appChallenge ? { appChallenge } : {}) },
        isSecure(req),
      ),
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    })
    .end();
}

export async function handleStatusAuthStart(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: LoginOptions,
): Promise<void> {
  await beginStatusAuth(req, res, url, options);
}

/**
 * iOSのASWebAuthenticationSessionから始めるGoogleログイン。
 * challengeはiOSが保持するverifierのS256値で、カスタムURLスキーム上のコードを
 * 別アプリに拾われても交換できないようにする。
 */
export async function handleStatusAppAuthStart(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: LoginOptions,
): Promise<void> {
  if (!options.supabase) {
    notFound(res);
    return;
  }
  const appChallenge = url.searchParams.get("code_challenge");
  if (!isAppChallenge(appChallenge)) {
    res
      .writeHead(400, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      })
      .end("invalid request\n");
    return;
  }
  await beginStatusAuth(req, res, url, options, appChallenge);
}

/**
 * Googleから戻ってきたところ。ここで初めて身元が分かる。
 *
 * 失敗の理由は画面には出さず（許可されているアドレスを当てる材料になる）、
 * ログにだけ残す。**往復用のCookieは成否によらず必ず消す。**
 */
export async function handleStatusAuthCallback(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: LoginOptions,
): Promise<void> {
  const config = options.supabase;
  if (!config) {
    notFound(res);
    return;
  }

  const secure = isSecure(req);
  const key = await loadSessionKey();
  const handshake = readHandshake(readCookie(req, HANDSHAKE_COOKIE), key);
  const cookies = [clearHandshakeCookie(secure)];

  // 戻り先はCookieが読めたときだけ分かる。読めなければ既定へ落ちる。
  const next = safeLanding(handshake?.next);

  const deny = (reason: string, message: string, status = 401): void => {
    console.warn(`[login] Googleログイン失敗: ${reason}`);
    if (handshake?.appChallenge) {
      res
        .writeHead(303, {
          Location: appCallbackUrl({ error: "login_failed" }),
          "Set-Cookie": cookies,
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        })
        .end();
      return;
    }
    html(res, status, renderLoginPage({ google: true, error: message, next }), { "Set-Cookie": cookies });
  };

  const failed = url.searchParams.get("error_description") ?? url.searchParams.get("error");
  if (failed) {
    deny(`Supabaseがエラーを返した: ${failed}`, "ログインを完了できませんでした。");
    return;
  }

  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (!code || !handshake || !stateMatches(state, handshake.state)) {
    // 往復のCookieが切れている・別のタブで始めたログインが混ざった場合もここへ来る。
    deny("ログインの往復を確認できなかった", "ログインをやり直してください。");
    return;
  }

  let user;
  try {
    user = await exchangeCode(config, { code, verifier: handshake.verifier });
  } catch (cause) {
    deny(String(cause instanceof Error ? cause.message : cause), "ログインを完了できませんでした。");
    return;
  }

  // 身元が分かった時点でSupabase側のセッションは用済み。以降は自前のCookieだけで通す。
  await revokeSession(config, user.accessToken);

  if (!isAllowedEmail(user.email, config)) {
    deny(`許可されていないアカウント: ${user.email}`, "このアカウントでは開けません。", 403);
    return;
  }

  console.log(`[login] Googleログイン成功: ${user.email}`);
  if (handshake.appChallenge) {
    const code = issueAppHandoff({
      email: user.email,
      next,
      challenge: handshake.appChallenge,
    });
    res
      .writeHead(303, {
        Location: appCallbackUrl({ code }),
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Set-Cookie": cookies,
      })
      .end();
    return;
  }

  cookies.push(loginCookie(key, { secure, email: user.email }));
  res.writeHead(303, { Location: next, "Cache-Control": "no-store", "Set-Cookie": cookies }).end();
}

/**
 * iOSが受け取った一回限りコードを、WKWebViewからのPOSTで画面用Cookieへ交換する。
 * codeとverifierはURLへ載せない。Cookieはこの応答でWKWebViewへ直接付ける。
 */
export async function handleStatusAppAuthConsume(
  req: IncomingMessage,
  res: ServerResponse,
  options: LoginOptions,
): Promise<void> {
  const config = options.supabase;
  if (!config) {
    notFound(res);
    return;
  }

  let form: URLSearchParams;
  try {
    form = await readForm(req);
  } catch {
    html(res, 400, renderLoginPage({ google: true, error: "ログインをやり直してください。" }), {
      "Referrer-Policy": "no-referrer",
    });
    return;
  }

  const handoff = consumeAppHandoff(form.get("code") ?? "", form.get("code_verifier") ?? "");
  if (!handoff || !isAllowedEmail(handoff.email, config)) {
    console.warn("[login] iOSアプリのログイン引き継ぎに失敗");
    html(res, 401, renderLoginPage({ google: true, error: "ログインをやり直してください。" }), {
      "Referrer-Policy": "no-referrer",
    });
    return;
  }

  res
    .writeHead(303, {
      Location: safeLanding(handoff.next),
      "Set-Cookie": loginCookie(await loadSessionKey(), {
        secure: isSecure(req),
        email: handoff.email,
      }),
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    })
    .end();
}

// ---- パスワードでのログイン（Google未設定の環境）----

export async function handleStatusLogin(
  req: IncomingMessage,
  res: ServerResponse,
  options: LoginOptions,
): Promise<void> {
  const config = options.authConfig;
  // Googleログインが有効な環境では、この受け口そのものを無くす。
  if (options.supabase) {
    notFound(res);
    return;
  }
  if (!config.enabled) {
    res.writeHead(303, { Location: DEFAULT_LANDING }).end();
    return;
  }

  // 総当たり対策は認可画面と同じ仕組みを使う。守っているパスワードが同じである以上、
  // 片方だけ無制限に試せると回数制限そのものが意味を失う。
  const key = clientKey(req);
  const locked = lockedFor(key);
  if (locked !== null) {
    html(
      res,
      429,
      renderLoginPage({
        google: false,
        error: `試行回数が多すぎます。${Math.ceil(locked / 60)}分後に試してください。`,
      }),
      { "Retry-After": String(locked) },
    );
    return;
  }

  const form = await readForm(req);
  const next = safeLanding(form.get("next"));
  if (!verifyPassword(form.get("password") ?? "", config.password!)) {
    recordFailure(key);
    console.warn(`[login] ログイン失敗: from=${key}`);
    await new Promise((resolve) => setTimeout(resolve, FAILURE_DELAY_MS));
    html(res, 401, renderLoginPage({ google: false, error: "パスワードが違います。", next }));
    return;
  }
  recordSuccess(key);

  res
    .writeHead(303, {
      Location: next,
      "Set-Cookie": loginCookie(await loadSessionKey(), { secure: isSecure(req), email: null }),
    })
    .end();
}

export function handleStatusLogout(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(303, { Location: DEFAULT_LANDING, "Set-Cookie": logoutCookie(isSecure(req)) }).end();
}
