import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthConfig } from "../auth/config.ts";
import { verifyPassword } from "../auth/config.ts";
import { clientKey, FAILURE_DELAY_MS, lockedFor, recordFailure, recordSuccess } from "../auth/ratelimit.ts";
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
import type { ToolRegistry } from "../mcp/registry.ts";
import { formatJst } from "../worker/notify.ts";
import { card, defList, escapeHtml, pill, renderPage, table, type Tone } from "./layout.ts";
import {
  loadSessionKey,
  loginCookie,
  logoutCookie,
  readCookie,
  SESSION_COOKIE,
  verifySession,
} from "./session.ts";

/**
 * 動作状況ページ（`GET /status`）。
 *
 * 「AIDEがいま正しく動いているか」をブラウザから確かめるための人間向けページ。
 * それまでは、Claudeに聞くかVPSのログを見るしか確かめる手段が無かった。
 *
 * **機能一覧（`/features`）とは公開範囲が正反対。** あちらは認証なしで公開する代わりに
 * 静的なカタログしか載せない。こちらは実データ（取得時刻・失敗理由・設定の有無）を載せるため、
 * パスワードの内側に置く。同じ配色・同じ部品を使うが、境界は混ぜない。
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
 * ログイン済みか。
 *
 * **認証が無効な環境（`AIDE_AUTH_DISABLED=1`）では素通しする。** MCPも `/api` も
 * 素通しになっている状態でこの画面だけログインを求めても、守るものが無い。
 * その場合はページ自身が「認証が無効」と警告を出す（`buildHealth`）。
 */
async function isSignedIn(req: IncomingMessage, config: AuthConfig): Promise<boolean> {
  if (!config.enabled) return true;
  return verifySession(readCookie(req, SESSION_COOKIE), await loadSessionKey());
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
export function renderStatusPage(health: Health, registry: ToolRegistry): string {
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
      ? `<form method="post" action="/status/logout"><button class="linkish" type="submit">ログアウト</button></form>`
      : "",
    body,
    footer:
      "このページはパスワード認証の内側にあります。シークレットの値・残高の金額は表示しません。",
  });
}

/** パスワードの入力画面。`error` があれば理由を出す。 */
export function renderLoginPage(error: string): string {
  return renderPage({
    title: TITLE,
    centered: true,
    body: `<form class="box" method="post" action="/status/login">
<span class="brand">AIDE</span>
<h1>動作状況を見る</h1>
<p>Claudeアプリの接続に使うパスワードと同じです。</p>
<label>パスワード<input type="password" name="password" autofocus required autocomplete="current-password"></label>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
<button type="submit">開く</button>
<p>5回間違えると15分ロックされます。</p>
</form>`,
  });
}

// ---- ハンドラ ----

function html(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res
    .writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...headers })
    .end(body);
}

export async function handleStatusPage(
  req: IncomingMessage,
  res: ServerResponse,
  options: StatusOptions,
): Promise<void> {
  if (!(await isSignedIn(req, options.authConfig))) {
    html(res, 200, renderLoginPage(""));
    return;
  }

  const health = await buildHealth({
    authEnabled: options.authConfig.enabled,
    baseUrl: options.baseUrl,
  });
  html(res, 200, renderStatusPage(health, options.registry));
}

export async function handleStatusLogin(
  req: IncomingMessage,
  res: ServerResponse,
  options: StatusOptions,
): Promise<void> {
  const config = options.authConfig;
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
      renderLoginPage(`試行回数が多すぎます。${Math.ceil(locked / 60)}分後に試してください。`),
      { "Retry-After": String(locked) },
    );
    return;
  }

  const form = await readForm(req);
  if (!verifyPassword(form.get("password") ?? "", config.password!)) {
    recordFailure(key);
    console.warn(`[status] ログイン失敗: from=${key}`);
    await new Promise((resolve) => setTimeout(resolve, FAILURE_DELAY_MS));
    html(res, 401, renderLoginPage("パスワードが違います。"));
    return;
  }
  recordSuccess(key);

  res
    .writeHead(303, {
      Location: "/status",
      "Set-Cookie": loginCookie(await loadSessionKey(), isSecure(req)),
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

/**
 * 疎通確認。**押されたときだけ走る。**
 *
 * 各コネクタを直接叩かず、MCPツールと同じ横断ビューを通す。ビュー側が失敗理由を
 * 外へ出してよい粒度（HTTPステータスと種別だけ）に丸めているため、URLやトークンが
 * 画面へ漏れる経路を新たに作らずに済む。
 */
export async function runProbes(): Promise<ProbeResult[]> {
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
  if (!(await isSignedIn(req, options.authConfig))) {
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
    .end(JSON.stringify({ results: await runProbes() }));
}
