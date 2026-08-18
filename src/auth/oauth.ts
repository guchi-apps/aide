import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadAuthConfig, resolveBaseUrl, verifyPassword } from "./config.ts";
import {
  allowRegistration,
  clientKey,
  FAILURE_DELAY_MS,
  lockedFor,
  recordFailure,
  recordSuccess,
} from "./ratelimit.ts";
import {
  addClient,
  addCode,
  addToken,
  consumeCode,
  consumeRefreshToken,
  findClient,
  findToken,
} from "./store.ts";
import { escapeHtml, renderPage } from "../web/layout.ts";

/**
 * MCP向けの OAuth 2.1 認可サーバー兼リソースサーバー。
 *
 * Claudeアプリが接続時に叩くパスは実測で判明している（2026-08-14）。
 *   /.well-known/oauth-protected-resource/mcp
 *   /.well-known/oauth-protected-resource
 *   /.well-known/oauth-authorization-server
 * これらが404を返すと無認証のまま接続を継続してしまうため、必ず応答する。
 *
 * 利用者が1人なので、認可はパスワード1つで行う。
 * クライアントは動的登録（RFC 7591）で client_secret を持たないため、PKCE を必須にする。
 */

const AUTH_CODE_TTL_MS = 60_000;
// 個人利用のため再認証の手間を避けて長めに取る。トークンはサーバー側照合なので、
// 漏洩時は data/auth/oauth-state.json を消せば即座に全失効できる。
const ACCESS_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000;

const token = () => randomBytes(32).toString("base64url");

function json(res: ServerResponse, status: number, body: unknown): void {
  res
    .writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    })
    .end(JSON.stringify(body));
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  const type = String(req.headers["content-type"] ?? "");
  if (type.includes("application/json")) {
    return new URLSearchParams(Object.entries(JSON.parse(raw) as Record<string, string>));
  }
  return new URLSearchParams(raw);
}

/** PKCE（S256）の検証。plain は受け付けない。 */
export function verifyPkce(verifier: string, challenge: string): boolean {
  return createHash("sha256").update(verifier).digest("base64url") === challenge;
}

// ---- メタデータ ----

export function protectedResourceMetadata(baseUrl: string): unknown {
  return {
    resource: `${baseUrl}/mcp`,
    authorization_servers: [baseUrl],
    bearer_methods_supported: ["header"],
  };
}

export function authorizationServerMetadata(baseUrl: string): unknown {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    registration_endpoint: `${baseUrl}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  };
}

// ---- 動的クライアント登録 (RFC 7591) ----

export async function handleRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // 登録エンドポイントは仕様上未認証で公開される。無制限に受け付けると状態ファイルが膨らむ。
  if (!allowRegistration(clientKey(req))) {
    json(res, 429, { error: "too_many_requests", error_description: "登録の回数制限を超えました" });
    return;
  }
  const form = await readForm(req);
  const redirectUris = form.getAll("redirect_uris");
  // JSONで {"redirect_uris": [...]} と来る場合、URLSearchParams化でカンマ連結された1件になる。
  const uris = (redirectUris.length === 1 ? redirectUris[0]!.split(",") : redirectUris)
    .map((u) => u.trim())
    .filter(Boolean);

  if (uris.length === 0) {
    json(res, 400, { error: "invalid_redirect_uri", error_description: "redirect_uris が必要です" });
    return;
  }

  const clientId = token();
  await addClient({
    clientId,
    clientName: form.get("client_name") ?? "unknown",
    redirectUris: uris,
    createdAt: new Date().toISOString(),
  });

  console.log(`[auth] クライアント登録: ${form.get("client_name")} -> ${uris.join(", ")}`);
  json(res, 201, {
    client_id: clientId,
    client_name: form.get("client_name"),
    redirect_uris: uris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
}

// ---- 認可エンドポイント ----

/**
 * 認可画面。見た目は他のページと共通の部品（`src/web/layout.ts`）に載せている。
 * **`clientName` は登録時にクライアントが名乗った値**なので、必ずエスケープして出す。
 */
const LOGIN_PAGE = (params: string, clientName: string, error: string): string =>
  renderPage({
    title: "AIDE への接続を許可",
    centered: true,
    // 接続を許可するだけの画面をホーム画面へ追加させない（マニフェストは機能一覧側だけ）。
    manifest: false,
    body: `<form class="box" method="post" action="/oauth/authorize?${escapeHtml(params)}">
<span class="brand">AIDE</span>
<h1>接続を許可する</h1>
<p>${escapeHtml(clientName)} が AIDE のデータへのアクセスを求めています。許可する場合はパスワードを入力してください。</p>
<label>パスワード<input type="password" name="password" autofocus required autocomplete="current-password"></label>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
<button type="submit">許可する</button>
</form>`,
  });

export async function handleAuthorize(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const config = loadAuthConfig();
  const clientId = url.searchParams.get("client_id") ?? "";
  const redirectUri = url.searchParams.get("redirect_uri") ?? "";
  const challenge = url.searchParams.get("code_challenge") ?? "";
  const method = url.searchParams.get("code_challenge_method") ?? "";
  const state = url.searchParams.get("state");

  const client = await findClient(clientId);
  // redirect_uri が登録済みでない場合、そこへリダイレクトするとオープンリダイレクトになる。
  // エラーもクライアントへ返さず、この画面で止める。
  if (!client || !client.redirectUris.includes(redirectUri)) {
    res
      .writeHead(400, { "Content-Type": "text/plain; charset=utf-8" })
      .end("client_id または redirect_uri が登録内容と一致しません");
    return;
  }
  if (method !== "S256" || !challenge) {
    res
      .writeHead(400, { "Content-Type": "text/plain; charset=utf-8" })
      .end("PKCE (code_challenge_method=S256) が必要です");
    return;
  }

  if (req.method === "GET") {
    res
      .writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
      .end(LOGIN_PAGE(url.searchParams.toString(), client.clientName, ""));
    return;
  }

  const key = clientKey(req);
  const locked = lockedFor(key);
  if (locked !== null) {
    res
      .writeHead(429, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Retry-After": String(locked) })
      .end(
        LOGIN_PAGE(
          url.searchParams.toString(),
          client.clientName,
          `試行回数が多すぎます。${Math.ceil(locked / 60)}分後に再試行してください。`,
        ),
      );
    return;
  }

  const form = await readForm(req);
  if (config.enabled && !verifyPassword(form.get("password") ?? "", config.password!)) {
    recordFailure(key);
    console.warn(`[auth] 認可失敗: client=${client.clientName} from=${key}`);
    // 機械的な連続試行の速度を落とす。
    await new Promise((resolve) => setTimeout(resolve, FAILURE_DELAY_MS));
    res
      .writeHead(401, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
      .end(LOGIN_PAGE(url.searchParams.toString(), client.clientName, "パスワードが違います"));
    return;
  }
  recordSuccess(key);

  const code = token();
  await addCode({
    code,
    clientId,
    redirectUri,
    codeChallenge: challenge,
    resource: url.searchParams.get("resource"),
    expiresAt: Date.now() + AUTH_CODE_TTL_MS,
  });

  const location = new URL(redirectUri);
  location.searchParams.set("code", code);
  if (state) location.searchParams.set("state", state);
  console.log(`[auth] 認可成功: client=${client.clientName}`);
  res.writeHead(302, { Location: location.toString(), "Cache-Control": "no-store" }).end();
}

// ---- トークンエンドポイント ----

export async function handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const form = await readForm(req);
  const grantType = form.get("grant_type");

  if (grantType === "refresh_token") {
    const previous = await consumeRefreshToken(form.get("refresh_token") ?? "");
    if (!previous) {
      json(res, 400, { error: "invalid_grant", error_description: "リフレッシュトークンが無効です" });
      return;
    }
    await issueTokens(res, previous.clientId);
    return;
  }

  if (grantType !== "authorization_code") {
    json(res, 400, { error: "unsupported_grant_type" });
    return;
  }

  const authCode = await consumeCode(form.get("code") ?? "");
  if (!authCode) {
    json(res, 400, { error: "invalid_grant", error_description: "認可コードが無効または期限切れです" });
    return;
  }
  if (authCode.redirectUri !== form.get("redirect_uri")) {
    json(res, 400, { error: "invalid_grant", error_description: "redirect_uri が一致しません" });
    return;
  }
  if (!verifyPkce(form.get("code_verifier") ?? "", authCode.codeChallenge)) {
    json(res, 400, { error: "invalid_grant", error_description: "code_verifier が一致しません" });
    return;
  }

  await issueTokens(res, authCode.clientId);
}

async function issueTokens(res: ServerResponse, clientId: string): Promise<void> {
  const accessToken = token();
  const refreshToken = token();
  await addToken({
    token: accessToken,
    clientId,
    refreshToken,
    expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
    createdAt: new Date().toISOString(),
  });
  json(res, 200, {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    refresh_token: refreshToken,
    refresh_expires_in: Math.floor(REFRESH_TOKEN_TTL_MS / 1000),
  });
}

// ---- Bearer 検証 ----

/**
 * MCPエンドポイントの保護。未認証なら 401 と WWW-Authenticate を返す。
 * このヘッダが無いとClaudeはディスカバリを始めず、そのまま接続を諦める。
 */
export async function requireBearer(
  req: IncomingMessage,
  res: ServerResponse,
  baseUrl: string,
): Promise<boolean> {
  if (!loadAuthConfig().enabled) return true;

  const header = String(req.headers["authorization"] ?? "");
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (presented && (await findToken(presented))) return true;

  res
    .writeHead(401, {
      "WWW-Authenticate": `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    })
    .end(JSON.stringify({ error: "invalid_token", error_description: "認証が必要です" }));
  return false;
}

export { resolveBaseUrl };
