import { createServer } from "node:http";
import { handleIngest } from "./api/ingest.ts";
import { handleMoneySummary } from "./api/read.ts";
import { handleZaimMaster, handleZaimPayment } from "./api/zaim.ts";
import { loadAuthConfig, resolveBaseUrl } from "./auth/config.ts";
import {
  authorizationServerMetadata,
  handleAuthorize,
  handleRegister,
  handleToken,
  protectedResourceMetadata,
  requireBearer,
} from "./auth/oauth.ts";
import { logRedirectCheck } from "./auth/redirect-check.ts";
import { CALLBACK_PATH, loadSupabaseAuthConfig } from "./auth/supabase.ts";
import { recordMcpAuthFailure } from "./mcp/access-log.ts";
import { McpTransport } from "./mcp/transport.ts";
import { ToolRegistry } from "./mcp/registry.ts";
import { dailyBriefingTool } from "./mcp/tools/briefing.ts";
import { claudeSessionsTool } from "./mcp/tools/claude-sessions.ts";
import { devStatusTool } from "./mcp/tools/dev.ts";
import { createIssueTool } from "./mcp/tools/issue.ts";
import { moneySummaryTool } from "./mcp/tools/money.ts";
import { opsStatusTool } from "./mcp/tools/ops.ts";
import { pingTool } from "./mcp/tools/ping.ts";
import { roomStatusTool } from "./mcp/tools/room.ts";
import { zaimMasterTool, zaimPaymentTool } from "./mcp/tools/zaim.ts";
import { handleAsset } from "./web/assets.ts";
import { handleFeaturesPage } from "./web/features.ts";
import { handleKnowledgePage } from "./web/knowledge.ts";
import {
  handleStatusAuthCallback,
  handleStatusAuthStart,
  handleStatusChecks,
  handleStatusLogin,
  handleStatusLogout,
  handleStatusPage,
  type StatusOptions,
} from "./web/status.ts";

/**
 * AIDE のエントリポイント。
 *
 * MCPサーバー・OAuth認可サーバー・REST APIを1プロセスで提供する。
 * VPSのメモリが2GBしかなく、常駐プロセスを増やしたくないため意図的に分けていない。
 * Playwright等の重い取得処理はここではなく worker 側で動かし、キャッシュ経由で読む。
 */

const PORT = Number(process.env["PORT"] ?? 4747);
const HOST = process.env["HOST"] ?? "127.0.0.1";

// 起動時に読んで、設定不備ならここで落とす。
// リクエストが来て初めて「認証が無効だった」と気づく事態を避ける。
const authConfig = loadAuthConfig();
// 動作状況ページのGoogleログイン。未設定なら null で、画面は従来のパスワードになる。
// 半端に設定されている場合はここで例外になる（許可メールだけ抜けた状態を通さないため）。
const supabaseAuthConfig = loadSupabaseAuthConfig();

const registry = new ToolRegistry();
registry.register(pingTool);
registry.register(moneySummaryTool);
registry.register(opsStatusTool);
registry.register(roomStatusTool);
registry.register(dailyBriefingTool);
registry.register(devStatusTool);
registry.register(createIssueTool);
registry.register(claudeSessionsTool);
// Zaimへの支出登録（#135）。**読み取り（候補の一覧）と書き込み（登録）を分けている。**
// 1本に畳むと、Claude Code側で「常に許可」にしたときに書き込みまで素通しになる。
registry.register(zaimMasterTool);
registry.register(zaimPaymentTool);

const mcp = new McpTransport(registry, { name: "aide", version: "0.1.0" });

const server = createServer((req, res) => {
  void handle(req, res).catch((cause: unknown) => {
    console.error("[server] 未処理の例外", cause);
    if (!res.headersSent) res.writeHead(500).end();
  });
});

async function handle(req: Parameters<typeof handleAuthorize>[0], res: Parameters<typeof handleAuthorize>[1]) {
  const baseUrl = resolveBaseUrl(req.headers);
  const url = new URL(req.url ?? "/", baseUrl);
  const path = url.pathname;

  // ルートを増やしたら src/web/features.ts の ENDPOINTS も更新する。
  // 機能一覧ページはそこだけ静的な宣言で、放置すると実態とずれる唯一の箇所。

  if (path === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" }).end("ok\n");
    return;
  }

  // アイコンとPWAマニフェスト。公開してよい静的ファイルなので認証は通さない。
  if (await handleAsset(req.method, path, res)) return;

  // 機能一覧。何が使えるかを載せるだけで実データは返さないため、認証は通さない。
  if (path === "/features" && (req.method === "GET" || req.method === "HEAD")) {
    handleFeaturesPage(res, registry, baseUrl);
    return;
  }

  // ---- 動作状況の画面 ----
  // **機能一覧とは公開範囲が逆で、実データを載せるためログインの内側に置く。**
  // 認証はMCPのOAuthではなく画面用のCookie（src/web/session.ts）。
  // Supabaseが設定されていれば許可メールだけのGoogleログイン、無ければパスワード。
  const statusOptions: StatusOptions = {
    authConfig,
    supabase: supabaseAuthConfig,
    baseUrl,
    registry,
  };
  if (path === "/status" && (req.method === "GET" || req.method === "HEAD")) {
    await handleStatusPage(req, res, statusOptions);
    return;
  }
  if (path === "/status/auth/start" && (req.method === "GET" || req.method === "HEAD")) {
    await handleStatusAuthStart(req, res, url, statusOptions);
    return;
  }
  if (path === CALLBACK_PATH && (req.method === "GET" || req.method === "HEAD")) {
    await handleStatusAuthCallback(req, res, url, statusOptions);
    return;
  }
  if (path === "/status/login" && req.method === "POST") {
    await handleStatusLogin(req, res, statusOptions);
    return;
  }
  if (path === "/status/logout" && req.method === "POST") {
    handleStatusLogout(req, res);
    return;
  }
  // 共通知識の画面（#161）。動作状況と同じログインの内側に置く。
  // **こちらは開くとGitHubへ問い合わせる。** 取得結果そのものが中身なので避けようがなく、
  // 代わりに数分キャッシュしている（src/web/knowledge.ts）。
  if (path === "/knowledge" && (req.method === "GET" || req.method === "HEAD")) {
    await handleKnowledgePage(req, res, url, statusOptions);
    return;
  }
  // 疎通確認。押したときだけ外部のコネクタへ問い合わせる。
  if (path === "/status/checks" && req.method === "POST") {
    await handleStatusChecks(req, res, statusOptions);
    return;
  }

  // ---- OAuth ディスカバリ ----
  // Claudeは接続時にこの3パスを順に叩く（2026-08-14 実測）。
  // 404を返すと無認証のまま接続を続けてしまうため、必ず応答する。
  if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
    res
      .writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" })
      .end(JSON.stringify(protectedResourceMetadata(baseUrl)));
    return;
  }
  if (path === "/.well-known/oauth-authorization-server") {
    res
      .writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" })
      .end(JSON.stringify(authorizationServerMetadata(baseUrl)));
    return;
  }

  // ---- OAuth エンドポイント ----
  if (path === "/oauth/register" && req.method === "POST") {
    await handleRegister(req, res);
    return;
  }
  if (path === "/oauth/authorize" && (req.method === "GET" || req.method === "POST")) {
    await handleAuthorize(req, res, url);
    return;
  }
  if (path === "/oauth/token" && req.method === "POST") {
    await handleToken(req, res);
    return;
  }

  // ---- worker からの取得結果の受け口 ----
  // MCPのOAuthとは別系統。呼び出し元が自分のworkerに限られるため共有シークレットで足りる。
  const ingestMatch = /^\/api\/cache\/([a-z0-9][a-z0-9-]*)$/.exec(path);
  if (ingestMatch && req.method === "POST") {
    await handleIngest(req, res, ingestMatch[1]!);
    return;
  }

  // ---- 個人アプリ向けの読み取りAPI ----
  // MCPと同じデータをRESTでも出す。こちらもOAuthとは別系統だが、
  // 読み取り側に書き込み権限を渡さないよう、受け口とはシークレットを分けている。
  if (path === "/api/money/summary") {
    await handleMoneySummary(req, res);
    return;
  }

  // ---- 個人アプリ向けのZaim登録API ----
  // Zaimの資格情報をAIDEだけに持たせるための口（#37）。上の2つとはさらに別のシークレットで、
  // 残高を読みたいだけのアプリへZaimへの書き込み権限を渡さない。
  if (path === "/api/zaim/payment") {
    await handleZaimPayment(req, res);
    return;
  }
  if (path === "/api/zaim/master") {
    await handleZaimMaster(req, res);
    return;
  }

  // ---- MCP ----
  if (path === "/mcp") {
    // プリフライトは認証前に通す。ここで401を返すとブラウザ経由の接続が始まらない。
    const startedAt = Date.now();
    if (req.method !== "OPTIONS" && !(await requireBearer(req, res, baseUrl))) {
      // **弾いたアクセスもここで記録する。** 401はこの行で終わり、transport まで届かない。
      // 記録しないと、Claudeのトークンが切れて呼び出しが全部落ちている状態と、
      // 誰も繋いでいない状態が動作状況ページで区別できない（#116）。
      void recordMcpAuthFailure({
        userAgent: req.headers["user-agent"],
        ms: Date.now() - startedAt,
      });
      return;
    }
    await mcp.handle(req, res, baseUrl);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" }).end("not found\n");
}

server.listen(PORT, HOST, () => {
  console.log(`AIDE listening on http://${HOST}:${PORT} (mcp: /mcp)`);
  console.log(`[auth] 認証: ${authConfig.enabled ? "有効" : "無効"}`);
  console.log(
    `[status] 画面のログイン: ${
      supabaseAuthConfig
        ? `Google（許可 ${supabaseAuthConfig.allowedEmails.length} 件）`
        : "パスワード（Googleログインは未設定）"
    }`,
  );

  // Googleログインの戻り先がSupabaseに登録されているかを起動時に一度だけ確かめる（#114）。
  // **待たない・失敗させない。** 判定にはSupabaseへの1往復が要り、相手が落ちているだけで
  // 起動が遅れたり止まったりしてよいものではない。壊れていた場合の唯一の気づき口が
  // ログである理由は src/auth/redirect-check.ts に書いてある。
  //
  // 公開URLは `AIDE_BASE_URL` からしか分からない（起動時点ではリクエストのHostが無い）。
  // 未設定＝ローカル開発なので、確認そのものを行わない。
  const publicBaseUrl = process.env["AIDE_BASE_URL"];
  if (supabaseAuthConfig && publicBaseUrl) {
    void logRedirectCheck(supabaseAuthConfig, publicBaseUrl.replace(/\/$/, "")).catch(
      (cause: unknown) => {
        console.warn("[status] Googleログインの戻り先の確認に失敗", cause);
      },
    );
  }
});
