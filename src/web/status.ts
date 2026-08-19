import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthConfig } from "../auth/config.ts";
import { verifyPassword } from "../auth/config.ts";
import { clientKey, FAILURE_DELAY_MS, lockedFor, recordFailure, recordSuccess } from "../auth/ratelimit.ts";
import { checkRedirectAllowed } from "../auth/redirect-check.ts";
import {
  authorizeUrl,
  callbackUrl,
  createPkce,
  exchangeCode,
  isAllowedEmail,
  revokeSession,
  type SupabaseAuthConfig,
} from "../auth/supabase.ts";
import { buildDevStatus } from "../core/views/dev.ts";
import {
  buildHealth,
  formatDuration,
  worst,
  type Health,
  type HealthSeverity,
} from "../core/views/health.ts";
import { buildMoneySummary } from "../core/views/money.ts";
import { buildOpsStatus } from "../core/views/ops.ts";
import { buildRoomStatus } from "../core/views/room.ts";
import type { ToolRegistry } from "../mcp/registry.ts";
import { formatJst } from "../worker/notify.ts";
import { card, defList, escapeHtml, pill, renderPage, table, type Tone } from "./layout.ts";
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
 * 動作状況ページ（`GET /status`）。
 *
 * 「AIDEがいま正しく動いているか」をブラウザから確かめるための人間向けページ。
 * それまでは、Claudeに聞くかVPSのログを見るしか確かめる手段が無かった。
 *
 * **機能一覧（`/features`）とは公開範囲が正反対。** あちらは認証なしで公開する代わりに
 * 静的なカタログしか載せない。こちらは実データ（取得時刻・失敗理由・設定の有無）を載せるため、
 * ログインの内側に置く。同じ配色・同じ部品を使うが、境界は混ぜない。
 *
 * **ログインの手段は設定で決まる。** Supabaseの設定（`src/auth/supabase.ts`）があれば
 * 許可したメールアドレスだけが通るGoogleログイン、無ければ従来のパスワードになる。
 * **併存はさせない。** パスワードを残したままにすると、「特定のメールアドレスの人しか
 * 開けない」という制限をパスワード1本で迂回できてしまう。
 *
 * 判定そのものは `src/core/views/health.ts` が持ち、ここは並べ方と色だけを決める。
 */

const TITLE = "AIDE の動作状況";

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

export interface StatusOptions {
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
 * その場合はページ自身が「認証が無効」と警告を出す（`buildHealth`）。
 *
 * **許可リストはCookieを出すときだけでなく、開くたびに照合する。** リストから外した
 * アドレスが、発行済みのCookieの有効期間（7日）だけ入れ続けられるのを避ける。
 */
async function currentSession(
  req: IncomingMessage,
  options: StatusOptions,
): Promise<StatusSession | null> {
  if (!options.authConfig.enabled) return { email: null };

  const session = readSession(readCookie(req, SESSION_COOKIE), await loadSessionKey());
  if (!session) return null;
  if (options.supabase && !isAllowedEmail(session.email, options.supabase)) return null;
  return session;
}

// ---- 表示 ----

const TONE: Record<HealthSeverity, Tone> = {
  ok: "ok",
  warn: "warn",
  danger: "danger",
  unknown: "muted",
};

const SEVERITY_LABEL: Record<HealthSeverity, string> = {
  ok: "正常",
  warn: "注意",
  danger: "異常",
  unknown: "記録なし",
};

function headline(health: Health): string {
  const count = health.attention.length;
  if (count === 0) return "異常はありません";
  return health.severity === "danger"
    ? `対応が必要なことが ${count} 件あります`
    : `注意が ${count} 件あります`;
}

function renderAttention(health: Health): string {
  if (health.attention.length === 0) return "";
  return `<ul class="attention">${health.attention
    .map(
      (item) =>
        `<li${item.severity === "danger" ? ' class="danger"' : ""}>${escapeHtml(item.message)}` +
        (item.action ? `<span class="fix">対応: ${escapeHtml(item.action)}</span>` : "") +
        `</li>`,
    )
    .join("")}</ul>`;
}

function serverCard(health: Health): string {
  const server = health.server;
  return card({
    title: "サーバー",
    status: pill(server.authEnabled ? "ok" : "danger", server.authEnabled ? "正常" : "認証が無効"),
    body: defList([
      ["稼働時間", escapeHtml(formatDuration(Math.round(server.uptimeSeconds / 60)))],
      ["起動", escapeHtml(formatJst(new Date(server.startedAt)))],
      ["バージョン", escapeHtml(server.version || "不明")],
      ["Node", escapeHtml(server.nodeVersion)],
      ["認証", escapeHtml(server.authEnabled ? "有効（パスワード）" : "無効（AIDE_AUTH_DISABLED=1）")],
      ["MCP接続先", `<span class="mono">${escapeHtml(server.mcpUrl)}</span>`],
    ]),
  });
}

function mcpCard(health: Health, registry: ToolRegistry): string {
  const tools = registry.list();
  return card({
    title: "MCP接続",
    meta: `ツール ${tools.length}`,
    status: pill("ok", "正常"),
    body:
      defList([
        ["登録クライアント", `${health.mcp.clients} 件`],
        [
          "有効なトークン",
          health.mcp.nearestExpiryAt
            ? `${health.mcp.tokens} 件（最短の期限 ${escapeHtml(formatJst(new Date(health.mcp.nearestExpiryAt)))}）`
            : `${health.mcp.tokens} 件`,
        ],
      ]) +
      `<ul class="chips">${tools.map((tool) => `<li>${escapeHtml(tool.name)}</li>`).join("")}</ul>`,
  });
}

function jobsCard(health: Health): string {
  const rows = health.jobs.map((job) => {
    const run = job.lastRun;
    return [
      `<span class="mono">${escapeHtml(job.name)}</span>`,
      escapeHtml(job.interval),
      run ? escapeHtml(formatJst(new Date(run.at))) : "—",
      run ? escapeHtml(formatDuration(run.ageMinutes)) + "前" : "—",
      pill(TONE[job.severity], run ? (run.ok ? "成功" : "失敗") : SEVERITY_LABEL[job.severity]),
    ];
  });

  // 失敗しているジョブの理由は一覧に収まらないため、表の下へ回す。
  const failures = health.jobs
    .filter((job) => job.lastRun && !job.lastRun.ok)
    .map((job) => `<p class="sub"><span class="mono">${escapeHtml(job.name)}</span>: ${escapeHtml(job.lastRun!.message)}</p>`)
    .join("");

  const severity = worst(health.jobs.map((job) => job.severity));

  return card({
    title: "定期ジョブ",
    meta: "worker",
    status: pill(TONE[severity], SEVERITY_LABEL[severity]),
    wide: true,
    body:
      table(["ジョブ", "実行間隔", "最後の実行", "経過", "状態"], rows) +
      failures +
      `<p class="sub">worker が実行のたびに残す記録を読んでいます。記録はサブPCからキャッシュ経由で届くため、
       まだ一度も動いていないジョブは「記録なし」になります。</p>`,
  });
}

function cacheCard(health: Health): string {
  const cache = health.cache;
  if (cache.empty) {
    return card({
      title: "キャッシュ",
      meta: cache.key,
      status: pill("muted", "記録なし"),
      body: `<p class="sub">まだ一度も巡回していません。zaim-sync が成功すると値が入ります。</p>`,
    });
  }

  return card({
    title: "キャッシュ",
    meta: cache.key,
    status: pill(TONE[cache.severity], SEVERITY_LABEL[cache.severity]),
    body:
      defList([
        ["取得", escapeHtml(formatJst(new Date(cache.fetchedAt!)))],
        ["経過", `${escapeHtml(formatDuration(cache.ageMinutes!))}前`],
        ["鮮度", cache.stale ? pill("warn", "期限切れ") : pill("ok", "期限内")],
        ["件数", `残高 ${cache.balances} 件 ／ 保有銘柄 ${cache.holdings} 件`],
        [
          "Zaim側が当日更新していない口座",
          cache.staleAccounts.length === 0
            ? "なし"
            : escapeHtml(cache.staleAccounts.join("・")),
        ],
      ]) + `<p class="sub">金額は表示しません。鮮度と件数だけを出しています。</p>`,
  });
}

function connectorsCard(health: Health): string {
  const missing = health.connectors.some((connector) => connector.configured === false);
  const rows = health.connectors.map((connector) => [
    `<span class="mono">${escapeHtml(connector.key)}</span>`,
    // worker 側（サブPC）の設定は、このサーバーの環境変数に無いので判定しない。
    // 未設定と出すと、正しく動いていても常に未設定に見える。
    connector.configured === null
      ? pill("muted", "worker側")
      : connector.configured
        ? pill("ok", "設定済み")
        : pill("warn", "未設定"),
    connector.probeable
      ? `<span id="probe-${escapeHtml(connector.key)}" class="mono">—</span>`
      : `<span class="sub">確認しない</span>`,
  ]);

  return card({
    title: "接続先",
    status: pill(missing ? "warn" : "ok", missing ? "未設定あり" : "正常"),
    body:
      table(["接続先", "設定", "疎通"], rows) +
      `<button class="act" type="button" id="probe-run">疎通を確認する</button>` +
      `<p class="sub">押したときだけ外部へ問い合わせます。worker（サブPC）側の設定はこのサーバーからは判定できないため、
       動いているかは上の定期ジョブの記録で確認してください。</p>`,
  });
}

/** 疎通確認のボタン。**外部ライブラリを読み込まない**ため素の fetch で書いている。 */
const PROBE_SCRIPT = `
<script>
document.getElementById('probe-run').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = '確認中…';
  try {
    const response = await fetch('/status/checks', { method: 'POST', headers: { 'x-requested-with': 'aide-status' } });
    const body = await response.json();
    for (const result of body.results ?? []) {
      const cell = document.getElementById('probe-' + result.key);
      if (!cell) continue;
      cell.textContent = result.ok ? result.ms + 'ms' : result.detail;
      cell.style.color = result.ok ? 'var(--ok)' : 'var(--bad)';
    }
    button.textContent = '再確認する';
  } catch {
    button.textContent = '確認できませんでした';
  } finally {
    button.disabled = false;
  }
});
</script>`;

/** ページのHTMLを組み立てる純粋関数。テストはここに当てる。 */
export function renderStatusPage(
  health: Health,
  registry: ToolRegistry,
  session: StatusSession | null = null,
): string {
  const body = `<section class="hero">
<div class="hero-top"><h1>${escapeHtml(headline(health))}</h1>${pill(TONE[health.severity], SEVERITY_LABEL[health.severity])}</div>
<div class="stamp"><span>確認 ${escapeHtml(formatJst(new Date(health.checkedAt)))}</span><span>稼働 ${escapeHtml(formatDuration(Math.round(health.server.uptimeSeconds / 60)))}</span><span>v${escapeHtml(health.server.version || "?")}</span><span>Node ${escapeHtml(health.server.nodeVersion)}</span></div>
${renderAttention(health)}
</section>
<div class="grid">
${serverCard(health)}
${mcpCard(health, registry)}
${jobsCard(health)}
${cacheCard(health)}
${connectorsCard(health)}
</div>${PROBE_SCRIPT}`;

  return renderPage({
    title: TITLE,
    nav: [
      { href: "/status", label: "動作状況", current: true },
      { href: "/features", label: "機能一覧", current: false },
    ],
    headerAction: health.server.authEnabled
      ? `${session?.email ? `<span class="who">${escapeHtml(session.email)}</span>` : ""}<form method="post" action="/status/logout"><button class="linkish" type="submit">ログアウト</button></form>`
      : "",
    body,
    footer: session?.email
      ? "このページは許可されたGoogleアカウントだけが開けます。シークレットの値・残高の金額は表示しません。"
      : "このページはパスワード認証の内側にあります。シークレットの値・残高の金額は表示しません。",
  });
}

/**
 * ログイン画面。`google` が true なら「Googleでログイン」だけを出す。
 *
 * **Googleログインが有効なときにパスワード欄を残さない。** 残すと、許可した
 * メールアドレスに絞った意味がパスワード1本で消える。
 */
export function renderLoginPage(options: { google: boolean; error?: string }): string {
  const error = options.error ? `<p class="err">${escapeHtml(options.error)}</p>` : "";

  const body = options.google
    ? `<div class="box">
<span class="brand">AIDE</span>
<h1>動作状況を見る</h1>
<p>許可されたGoogleアカウントだけが開けます。</p>
${error}
<a class="signin" href="/status/auth/start">Googleでログイン</a>
</div>`
    : `<form class="box" method="post" action="/status/login">
<span class="brand">AIDE</span>
<h1>動作状況を見る</h1>
<p>Claudeアプリの接続に使うパスワードと同じです。</p>
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

/** 設定上そのエンドポイントが存在しない場合。サーバーの既定の404と同じ見た目にする。 */
function notFound(res: ServerResponse): void {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not found\n");
}

export async function handleStatusPage(
  req: IncomingMessage,
  res: ServerResponse,
  options: StatusOptions,
): Promise<void> {
  const session = await currentSession(req, options);
  if (!session) {
    html(res, 200, renderLoginPage({ google: options.supabase !== null }));
    return;
  }

  const health = await buildHealth({
    authEnabled: options.authConfig.enabled,
    supabase: options.supabase,
    baseUrl: options.baseUrl,
  });
  html(res, 200, renderStatusPage(health, options.registry, session));
}

// ---- Googleログイン ----

/**
 * Googleへ送り出す。**素のリンクで踏めるようにGETで受ける。**
 * ボタンのJavaScriptに依存させると、スクリプトが動かない環境で押しても何も起きない
 * （guchi-apps/docs の knowledge/supabase.md）。
 */
export async function handleStatusAuthStart(
  req: IncomingMessage,
  res: ServerResponse,
  options: StatusOptions,
): Promise<void> {
  const config = options.supabase;
  if (!config) {
    notFound(res);
    return;
  }

  const { verifier, challenge } = createPkce();
  const state = randomBytes(16).toString("base64url");

  // 戻り先に state を載せる。Supabaseは redirect_to のクエリをそのまま残して戻す。
  // 組み立ては callbackUrl() に寄せてある（検証と同じ形にするため。src/auth/redirect-check.ts）。
  const redirect = callbackUrl(options.baseUrl, state);

  res
    .writeHead(302, {
      Location: authorizeUrl(config, { redirectUri: redirect, challenge }),
      "Set-Cookie": handshakeCookie(await loadSessionKey(), { state, verifier }, isSecure(req)),
      "Cache-Control": "no-store",
    })
    .end();
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
  options: StatusOptions,
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

  const deny = (reason: string, message: string): void => {
    console.warn(`[status] Googleログイン失敗: ${reason}`);
    html(res, 401, renderLoginPage({ google: true, error: message }), { "Set-Cookie": cookies });
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
    console.warn(`[status] 許可されていないアカウントのログイン試行: ${user.email}`);
    html(res, 403, renderLoginPage({ google: true, error: "このアカウントでは開けません。" }), {
      "Set-Cookie": cookies,
    });
    return;
  }

  console.log(`[status] Googleログイン成功: ${user.email}`);
  cookies.push(loginCookie(key, { secure, email: user.email }));
  res.writeHead(303, { Location: "/status", "Cache-Control": "no-store", "Set-Cookie": cookies }).end();
}

// ---- パスワードでのログイン（Google未設定の環境）----

export async function handleStatusLogin(
  req: IncomingMessage,
  res: ServerResponse,
  options: StatusOptions,
): Promise<void> {
  const config = options.authConfig;
  // Googleログインが有効な環境では、この受け口そのものを無くす。
  if (options.supabase) {
    notFound(res);
    return;
  }
  if (!config.enabled) {
    res.writeHead(303, { Location: "/status" }).end();
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
  if (!verifyPassword(form.get("password") ?? "", config.password!)) {
    recordFailure(key);
    console.warn(`[status] ログイン失敗: from=${key}`);
    await new Promise((resolve) => setTimeout(resolve, FAILURE_DELAY_MS));
    html(res, 401, renderLoginPage({ google: false, error: "パスワードが違います。" }));
    return;
  }
  recordSuccess(key);

  res
    .writeHead(303, {
      Location: "/status",
      "Set-Cookie": loginCookie(await loadSessionKey(), { secure: isSecure(req), email: null }),
    })
    .end();
}

export function handleStatusLogout(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(303, { Location: "/status", "Set-Cookie": logoutCookie(isSecure(req)) }).end();
}

export interface ProbeResult {
  key: string;
  ok: boolean;
  /** 応答までのミリ秒。 */
  ms: number;
  /** 失敗の理由。外へ出してよい粒度まで丸めたもの（コネクタ側で処理済み）。 */
  detail: string;
}

export interface ProbeOptions {
  /** Googleログインの設定。未設定なら戻り先の確認は行わない。 */
  supabase?: SupabaseAuthConfig | null;
  /** 戻り先を組み立てるための公開URL。 */
  baseUrl?: string;
}

/**
 * 疎通確認。**押されたときだけ走る。**
 *
 * 各コネクタを直接叩かず、MCPツールと同じ横断ビューを通す。ビュー側が失敗理由を
 * 外へ出してよい粒度（HTTPステータスと種別だけ）に丸めているため、URLやトークンが
 * 画面へ漏れる経路を新たに作らずに済む。
 *
 * **Googleログインの戻り先（`supabase-redirect`）だけは横断ビューを持たない。**
 * 畳む先の「外の世界」が無く、確かめたいのはSupabase側の設定とこちらの組み立てが
 * 一致しているかどうかだけなので、`src/auth/redirect-check.ts` を直接呼ぶ。
 */
export async function runProbes(options: ProbeOptions = {}): Promise<ProbeResult[]> {
  const { supabase, baseUrl } = options;
  const measure = async (
    key: string,
    run: () => Promise<{ ok: boolean; detail: string }>,
  ): Promise<ProbeResult> => {
    const startedAt = Date.now();
    try {
      const { ok, detail } = await run();
      return { key, ok, ms: Date.now() - startedAt, detail };
    } catch (cause) {
      return {
        key,
        ok: false,
        ms: Date.now() - startedAt,
        // 例外の message にはURLが載ることがある。種別だけに落とす。
        detail: cause instanceof Error ? cause.name : "取得に失敗した",
      };
    }
  };

  return Promise.all([
    // Googleログインを使っていないときは行そのものが無いので確認しない（readConnectors と対）。
    ...(supabase && baseUrl
      ? [
          measure("supabase-redirect", async () => {
            const result = await checkRedirectAllowed(supabase, baseUrl);
            return { ok: result.status === "ok", detail: result.detail };
          }),
        ]
      : []),
    measure("ops-dashboard", async () => {
      const status = await buildOpsStatus();
      return {
        ok: status.configured && status.complete,
        detail: status.unavailable[0]?.reason ?? (status.configured ? "" : "未設定"),
      };
    }),
    measure("github", async () => {
      const status = await buildDevStatus();
      return {
        ok: status.configured && status.complete,
        detail: status.unavailable[0]?.reason ?? (status.configured ? "" : "未設定"),
      };
    }),
    measure("myroom", async () => {
      const status = await buildRoomStatus();
      return {
        ok: status.configured && status.complete,
        detail: status.unavailable[0]?.reason ?? (status.configured ? "" : "未設定"),
      };
    }),
    measure("subscription-lists", async () => {
      const summary = await buildMoneySummary();
      return {
        ok: summary.fixedCosts.configured && summary.fixedCosts.unavailable === null,
        detail: summary.fixedCosts.unavailable?.reason ?? (summary.fixedCosts.configured ? "" : "未設定"),
      };
    }),
  ]);
}

export async function handleStatusChecks(
  req: IncomingMessage,
  res: ServerResponse,
  options: StatusOptions,
): Promise<void> {
  if (!(await currentSession(req, options))) {
    res
      .writeHead(401, { "Content-Type": "application/json; charset=utf-8" })
      .end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  // 他のサイトに置かれたフォームから押させて、外部への問い合わせを踏ませない。
  // ページ内の fetch は必ずこのヘッダを付ける（単純フォームでは付けられない）。
  if (req.headers["x-requested-with"] !== "aide-status") {
    res
      .writeHead(403, { "Content-Type": "application/json; charset=utf-8" })
      .end(JSON.stringify({ error: "forbidden" }));
    return;
  }

  res
    .writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
    .end(
      JSON.stringify({
        results: await runProbes({ supabase: options.supabase, baseUrl: options.baseUrl }),
      }),
    );
}
