import { createServer } from "node:http";
import { handleImageMailSend } from "./api/image-mail.ts";
import { handleIngest } from "./api/ingest.ts";
import { handleNewsMailSend } from "./api/news-mail.ts";
import { handleMoneySummary, handleMoneyTransactions } from "./api/read.ts";
import { handleStatusApi, handleStatusApiChecks, type StatusApiOptions } from "./api/status.ts";
import {
  handleZaimMaster,
  handleZaimPayment,
  handleZaimWebGenreEdit,
  handleZaimWebMemoEdit,
  handleZaimWebPayment,
} from "./api/zaim.ts";
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
import { buildToolRegistry } from "./mcp/catalog.ts";
import { handleAsset } from "./web/assets.ts";
import { handleFeaturesPage } from "./web/features.ts";
import {
  handleStatusAuthCallback,
  handleStatusAuthStart,
  handleStatusLogin,
  handleStatusLogout,
  type LoginOptions,
} from "./web/login.ts";
import { handleMapIssue, handleMapPage } from "./web/map.ts";

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
// 画面のGoogleログイン。未設定なら null で、画面は従来のパスワードになる。
// 半端に設定されている場合はここで例外になる（許可メールだけ抜けた状態を通さないため）。
const supabaseAuthConfig = loadSupabaseAuthConfig();

const registry = buildToolRegistry();

// ops-dashboard向けの動作状況JSON API（#276）。
const statusApiOptions: StatusApiOptions = {
  authConfig,
  supabase: supabaseAuthConfig,
  registry,
};

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

  // ---- 画面（アプリ連携 #328・機能一覧 #332） ----
  // **どちらもログインの内側に置く。** 公開してよい静的ファイル（上のアイコン等）とは扱いが違う。
  // 認証はMCPのOAuthではなく画面用のCookie（src/web/session.ts）。
  // Supabaseが設定されていれば許可メールだけのGoogleログイン、無ければパスワード。
  const loginOptions: LoginOptions = {
    authConfig,
    supabase: supabaseAuthConfig,
    baseUrl,
    registry,
  };
  if (path === "/map" && (req.method === "GET" || req.method === "HEAD")) {
    await handleMapPage(req, res, loginOptions);
    return;
  }
  // 「機能を同期」の結果からIssueを起案する（#355）。ログインの関門は handleMapIssue が通す。
  if (path === "/map/issue" && req.method === "POST") {
    await handleMapIssue(req, res, loginOptions);
    return;
  }
  if (path === "/features" && (req.method === "GET" || req.method === "HEAD")) {
    await handleFeaturesPage(req, res, loginOptions);
    return;
  }
  // 以前あった動作状況（→ ops-dashboard の「AIDE」タブ）と共通知識（→ IssueDeck）の画面。
  // ホーム画面のショートカットやブックマークから来た人を、404ではなく今の画面へ送る。
  if ((path === "/status" || path === "/knowledge") && (req.method === "GET" || req.method === "HEAD")) {
    res.writeHead(302, { Location: "/map", "Cache-Control": "no-store" }).end();
    return;
  }
  // ログインの受け口。**パスが /status/... のままなのは、Supabaseに登録した戻り先を変えないため**
  // （src/web/login.ts）。
  if (path === "/status/auth/start" && (req.method === "GET" || req.method === "HEAD")) {
    await handleStatusAuthStart(req, res, url, loginOptions);
    return;
  }
  if (path === CALLBACK_PATH && (req.method === "GET" || req.method === "HEAD")) {
    await handleStatusAuthCallback(req, res, url, loginOptions);
    return;
  }
  if (path === "/status/login" && req.method === "POST") {
    await handleStatusLogin(req, res, loginOptions);
    return;
  }
  if (path === "/status/logout" && req.method === "POST") {
    handleStatusLogout(req, res);
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
  // Zaim Web版の家計簿明細一覧（公式APIが返さない自動連携明細を含む）を読む口（#244）。
  if (path === "/api/money/transactions") {
    await handleMoneyTransactions(req, res);
    return;
  }

  // ---- ops-dashboard向けの動作状況API（#276） ----
  // 動作状況の判定 buildHealth() をサーバー間で読める形で出す。人が見るのは ops-dashboard の画面。
  // AIDE_READ_SECRET とは別のシークレット（AIDE_STATUS_SECRET）で認証する。
  if (path === "/api/status") {
    await handleStatusApi(req, res, statusApiOptions);
    return;
  }
  if (path === "/api/status/checks") {
    await handleStatusApiChecks(req, res, statusApiOptions);
    return;
  }

  // ---- 個人アプリ向けのZaim登録API ----
  // Zaimの資格情報をAIDEだけに持たせるための口（#37）。上の2つとはさらに別のシークレットで、
  // 残高を読みたいだけのアプリへZaimへの書き込み権限を渡さない。
  if (path === "/api/zaim/payment") {
    await handleZaimPayment(req, res);
    return;
  }
  // Web版の入力画面を操作して登録する口（#214）。公式APIで作った明細はZaimの
  // 「レシート置き換え」の候補にならないため、置き換えに載せたいものはこちらを通す。
  // **Playwrightとログイン状態がある実行環境（サブPC）でだけ成立する。**
  if (path === "/api/zaim/payment/web") {
    await handleZaimWebPayment(req, res);
    return;
  }
  // 既存明細（自動連携明細を含む）のカテゴリ・内訳だけを編集画面から変更する口（#273）。
  // 上と同じくPlaywrightとログイン状態がある実行環境（サブPC）でだけ成立する。
  if (path === "/api/zaim/payment/web/genre") {
    await handleZaimWebGenreEdit(req, res);
    return;
  }
  // 既存明細（自動連携明細を含む）のメモだけを編集画面から書き換える口（#354）。
  // 上と同じくPlaywrightとログイン状態がある実行環境（サブPC）でだけ成立する。
  if (path === "/api/zaim/payment/web/memo") {
    await handleZaimWebMemoEdit(req, res);
    return;
  }
  if (path === "/api/zaim/master") {
    await handleZaimMaster(req, res);
    return;
  }

  // ---- 画像メール送信API（#230） ----
  // Research Desk**のサーバー**からmultipart/form-dataで届く画像ZIPをGmailで送る。
  // サーバー間通信のためCORS対応は不要。公開URLの遮断リスト（README「公開URLからの遮断」）
  // には入れない——Research Desk側から直接届く必要があるため。
  if (path === "/api/image-mail/send") {
    await handleImageMailSend(req, res);
    return;
  }

  // ---- 業界ニュース週報メール送信API（#257） ----
  // Research Desk**のサーバー**からapplication/jsonで届くHTML/テキスト本文をGmailで送る。
  // 画像メールと同じくサーバー間通信で、公開URLの遮断リストには入れない。
  if (path === "/api/news-mail/send") {
    await handleNewsMailSend(req, res);
    return;
  }

  // ---- MCP ----
  if (path === "/mcp") {
    // プリフライトは認証前に通す。ここで401を返すとブラウザ経由の接続が始まらない。
    const startedAt = Date.now();
    if (req.method !== "OPTIONS" && !(await requireBearer(req, res, baseUrl))) {
      // **弾いたアクセスもここで記録する。** 401はこの行で終わり、transport まで届かない。
      // 記録しないと、Claudeのトークンが切れて呼び出しが全部落ちている状態と、
      // 誰も繋いでいない状態が動作状況（ops-dashboard）で区別できない（#116）。
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
