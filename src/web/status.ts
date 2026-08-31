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
import { probeZaimWebUpstream } from "../core/connectors/zaim/web-payment-forward.ts";
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
import { buildSchedule } from "../core/views/schedule.ts";
import {
  AUTH_METHOD,
  isQuietMethod,
  MAX_ENTRIES,
  type McpAccessEntry,
  type McpAccessSummary,
} from "../mcp/access-log.ts";
import type { ToolRegistry } from "../mcp/registry.ts";
import { formatJst } from "../worker/notify.ts";
import {
  card,
  defList,
  escapeHtml,
  isSiteNavPath,
  pill,
  renderPage,
  siteNav,
  table,
  type Tone,
} from "./layout.ts";
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
 *
 * 共通知識ページ（`src/web/knowledge.ts`）も同じ関門を通す。**画面ごとに判定を書かない。**
 * 片方だけ条件が古くなると、そこが素通しの入口になる。
 */
export async function currentSession(
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
  // 記録に残っている範囲での呼び出し回数。0回のツールには何も添えない
  // （「一度も呼ばれていない」と「記録が流れて消えた」を見分けられないため）。
  const counts = new Map(health.mcpAccess.toolCounts.map(({ tool, count }) => [tool, count]));
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
      `<ul class="chips">${tools
        .map((tool) => {
          const count = counts.get(tool.name);
          return `<li>${escapeHtml(tool.name)}${count ? `<span class="c">${count}</span>` : ""}</li>`;
        })
        .join("")}</ul>` +
      `<p class="sub">数字は記録に残っている範囲での呼び出し回数です。</p>`,
  });
}

/** メソッドの日本語。ツールの呼び出し以外は、何をしたのかが名前から読めないため置き換える。 */
const METHOD_LABEL: Record<string, string> = {
  [AUTH_METHOD]: "認証で拒否",
  initialize: "接続開始",
  ping: "接続確認",
  "tools/list": "ツール一覧",
  "resources/list": "リソース一覧",
  "prompts/list": "プロンプト一覧",
};

/** 記録の時刻。今日のぶんは時刻だけにして、日付の繰り返しで表を太らせない。 */
function logTime(at: string, now: Date): string {
  const [date = "", time = ""] = formatJst(new Date(at)).replace(" JST", "").split(" ");
  const today = formatJst(now).replace(" JST", "").split(" ")[0];
  return date === today ? time : `${date.slice(5)} ${time.slice(0, 5)}`;
}

function operation(entry: McpAccessEntry): string {
  const name = entry.tool
    ? `<span class="mono">${escapeHtml(entry.tool)}</span>`
    : entry.method.startsWith("notifications/")
      ? `通知（<span class="mono">${escapeHtml(entry.method.slice("notifications/".length))}</span>）`
      : escapeHtml(METHOD_LABEL[entry.method] ?? entry.method);
  // 失敗の理由は列を増やさず、その行の下へ回す（定期ジョブの表と同じ扱い）。
  return entry.ok || !entry.detail ? name : `${name}<span class="why">${escapeHtml(entry.detail)}</span>`;
}

/**
 * MCPへのアクセスの記録（#116）。
 *
 * 呼ばれた事実だけを並べる。**引数と応答の中身は記録していない**ので、ここに出せるのは
 * 「いつ・誰が・どのツールを・成功したか」まで。中身が要るときはClaudeに聞くことになる。
 */
function mcpAccessCard(access: McpAccessSummary, now: Date): string {
  if (access.total === 0) {
    return card({
      title: "MCPアクセス",
      status: pill("muted", "記録なし"),
      wide: true,
      body: `<p class="sub">まだ記録がありません。ClaudeアプリがMCPへ接続すると、ここに1件ずつ残ります。</p>`,
    });
  }

  const rows = access.entries.map((entry) => [
    `<span class="when">${escapeHtml(logTime(entry.at, now))}</span>`,
    escapeHtml(entry.client ?? "不明"),
    operation(entry),
    pill(entry.ok ? "ok" : "danger", entry.ok ? "成功" : "失敗"),
    `${entry.ms.toLocaleString("ja-JP")}ms`,
  ]);
  const rowClasses = access.entries.map((entry) =>
    isQuietMethod(entry.method) ? "quiet" : undefined,
  );

  return card({
    title: "MCPアクセス",
    meta: `直近 ${access.total} 件`,
    status: pill(TONE[access.severity], SEVERITY_LABEL[access.severity]),
    wide: true,
    body:
      defList([
        [
          "最後のアクセス",
          `${escapeHtml(formatJst(new Date(access.lastAt!)))}（${escapeHtml(formatDuration(access.lastAgeMinutes ?? 0))}前）`,
        ],
        [
          "ツール呼び出し",
          `${access.toolCalls} 件${access.failures > 0 ? `（失敗 ${access.failures} 件）` : ""}`,
        ],
        [
          "接続クライアント",
          access.clients.length === 0 ? "不明" : escapeHtml(access.clients.join(" ／ ")),
        ],
        // 0件のときは行ごと出さない。常時0が並ぶと、実際に弾いたときの1が目に入らない。
        ...(access.authFailures > 0
          ? ([["認証で拒否", `${access.authFailures} 件（同じ相手の連続は1分に1件だけ残します）`]] as [
              string,
              string,
            ][])
          : []),
      ]) +
      `<div class="log">` +
      `<input type="checkbox" id="mcp-quiet" class="logtoggle">` +
      `<label class="logfilter" for="mcp-quiet">接続確認・一覧の取得も表示する</label>` +
      table(["時刻", "クライアント", "操作", "結果", "所要"], rows, rowClasses) +
      `</div>` +
      (access.visible === 0
        ? `<p class="sub">直近の記録は接続確認だけです。上のチェックを入れると表示します。</p>`
        : "") +
      `<p class="sub">呼ばれた事実だけを残します（引数・応答の中身・アクセス元は記録しません）。
       直近${MAX_ENTRIES}件を保ち、古いものから消えます。</p>`,
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
${mcpAccessCard(health.mcpAccess, new Date(health.checkedAt))}
${jobsCard(health)}
${cacheCard(health)}
${connectorsCard(health)}
</div>${PROBE_SCRIPT}`;

  return renderPage({
    title: TITLE,
    nav: siteNav("status"),
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
export function renderLoginPage(options: {
  google: boolean;
  error?: string;
  /**
   * ログイン後に戻る画面。**開こうとした画面をここへ入れる。**
   * 入れないと、共通知識ページを直接開いた人がログイン後に動作状況へ落ちて戻ってこない。
   */
  next?: string;
}): string {
  const error = options.error ? `<p class="err">${escapeHtml(options.error)}</p>` : "";
  const next = safeLanding(options.next);
  const heading = next === "/knowledge" ? "共通知識を見る" : "動作状況を見る";

  const body = options.google
    ? `<div class="box">
<span class="brand">AIDE</span>
<h1>${escapeHtml(heading)}</h1>
<p>許可されたGoogleアカウントだけが開けます。</p>
${error}
<a class="signin" href="/status/auth/start?next=${encodeURIComponent(next)}">Googleでログイン</a>
</div>`
    : `<form class="box" method="post" action="/status/login">
<span class="brand">AIDE</span>
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

/** ログイン後の既定の戻り先。 */
const DEFAULT_LANDING = "/status";

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
  url: URL,
  options: StatusOptions,
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
      "Set-Cookie": handshakeCookie(await loadSessionKey(), { state, verifier, next }, isSecure(req)),
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

  // 戻り先はCookieが読めたときだけ分かる。読めなければ既定へ落ちる。
  const next = safeLanding(handshake?.next);

  const deny = (reason: string, message: string): void => {
    console.warn(`[status] Googleログイン失敗: ${reason}`);
    html(res, 401, renderLoginPage({ google: true, error: message, next }), { "Set-Cookie": cookies });
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
    html(res, 403, renderLoginPage({ google: true, error: "このアカウントでは開けません。", next }), {
      "Set-Cookie": cookies,
    });
    return;
  }

  console.log(`[status] Googleログイン成功: ${user.email}`);
  cookies.push(loginCookie(key, { secure, email: user.email }));
  res.writeHead(303, { Location: next, "Cache-Control": "no-store", "Set-Cookie": cookies }).end();
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
    console.warn(`[status] ログイン失敗: from=${key}`);
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
    measure("dayspan", async () => {
      // 期限切れタスクは取りにいかない（Notionへの往復が1回減る）。疎通の確認に要らない。
      const summary = await buildSchedule({ days: 1, overdueDays: 0 });
      return {
        ok: summary.configured && summary.complete,
        detail: summary.unavailable[0]?.reason ?? (summary.configured ? "" : "未設定"),
      };
    }),
    measure("subscription-lists", async () => {
      const summary = await buildMoneySummary();
      return {
        ok: summary.fixedCosts.configured && summary.fixedCosts.unavailable === null,
        detail: summary.fixedCosts.unavailable?.reason ?? (summary.fixedCosts.configured ? "" : "未設定"),
      };
    }),
    // **横断ビューを持たない**（Googleログインの戻り先と同じ）。畳む先の「外の世界」が無く、
    // 確かめたいのは中継先が生きているかどうかだけなので、コネクタを直接叩く（#215）。
    measure("zaim-web-upstream", async () => probeZaimWebUpstream()),
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
