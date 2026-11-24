import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

// 本番の状態を汚さないよう、store の読み込み前に置き場を差し替える。
process.env["AIDE_AUTH_STATE_PATH"] = join(await mkdtemp(join(tmpdir(), "aide-mail-scope-")), "oauth-state.json");
process.env["AIDE_AUTH_PASSWORD"] = "pw-for-test";
const { handleAuthorize, handleRegister, handleToken, MAIL_READ_SCOPE, parseSupportedScopes } = await import("./oauth.ts");
const { resetRateLimits } = await import("./ratelimit.ts");
const { findToken } = await import("./store.ts");
const { safeLanding, isOAuthAuthorizeReturn } = await import("../web/login.ts");
import type { AuthorizeIdentity } from "./oauth.ts";

/** #905: `mail:read` の認可は本人（Googleログイン）を記録し、リフレッシュ後も引き継ぐ。 */

let identity: AuthorizeIdentity | null = null;
let server: Server;
let base = "";

before(async () => {
  server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/oauth/register") return handleRegister(req, res);
      if (url.pathname === "/oauth/token") return handleToken(req, res);
      if (url.pathname === "/oauth/authorize") return handleAuthorize(req, res, url, identity);
      res.writeHead(404).end();
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const VERIFIER = "v".repeat(43);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const REDIRECT = "https://claude.ai/cb";

async function register(): Promise<string> {
  const res = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "t", redirect_uris: [REDIRECT] }),
  });
  return ((await res.json()) as { client_id: string }).client_id;
}

function authorizeQuery(clientId: string, scope: string): string {
  return new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    scope,
    state: "s",
  }).toString();
}

async function authorize(clientId: string, scope: string): Promise<Response> {
  resetRateLimits();
  return fetch(`${base}/oauth/authorize?${authorizeQuery(clientId, scope)}`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "password=pw-for-test",
  });
}

async function exchange(code: string): Promise<{ access_token: string; refresh_token: string; scope: string }> {
  const res = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: VERIFIER }),
  });
  return (await res.json()) as { access_token: string; refresh_token: string; scope: string };
}

const codeOf = (res: Response) => new URL(res.headers.get("location")!).searchParams.get("code")!;

describe("mail:read の認可と本人の記録（#905）", () => {
  it("mail:read は対応scopeとして付与できる", () => {
    assert.deepEqual(parseSupportedScopes("mail:read mail:send"), [MAIL_READ_SCOPE]);
  });

  it("ログイン中の本人をトークンへ記録し、リフレッシュ後も引き継ぐ", async () => {
    identity = { current: async () => ({ sub: "sub-1", email: "Owner@Example.com" }), loginPath: "/status/auth/start" };
    const clientId = await register();
    const res = await authorize(clientId, "mail:read tasks:read");
    assert.equal(res.status, 302);
    const tokens = await exchange(codeOf(res));
    assert.equal(tokens.scope, "mail:read tasks:read");
    assert.deepEqual((await findToken(tokens.access_token))?.subject, { sub: "sub-1", email: "Owner@Example.com" });

    const refreshed = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }),
    });
    const next = (await refreshed.json()) as { access_token: string };
    assert.deepEqual((await findToken(next.access_token))?.subject, { sub: "sub-1", email: "Owner@Example.com" });
  });

  it("未ログインならGoogleログインへ送り、戻り先に認可のURLを載せる（パスワードは先に聞かない）", async () => {
    identity = { current: async () => null, loginPath: "/status/auth/start" };
    const clientId = await register();
    const query = authorizeQuery(clientId, "mail:read");
    const res = await fetch(`${base}/oauth/authorize?${query}`, { redirect: "manual" });
    assert.equal(res.status, 302);
    const location = new URL(res.headers.get("location")!, base);
    assert.equal(location.pathname, "/status/auth/start");
    const next = location.searchParams.get("next")!;
    assert.equal(next, `/oauth/authorize?${query}`);
    assert.equal(safeLanding(next), next, "ログイン後に認可画面へ戻れる");
  });

  it("mail:read を求めない認可は、本人が無くても従来どおり通り、本人は記録しない", async () => {
    identity = { current: async () => ({ sub: "s", email: "a@example.com" }), loginPath: "/status/auth/start" };
    const clientId = await register();
    const tokens = await exchange(codeOf(await authorize(clientId, "tasks:read")));
    assert.equal((await findToken(tokens.access_token))?.subject, undefined);
  });

  it("Googleログインが無い環境では mail:read だけを付けずに接続は続ける", async () => {
    identity = { current: async () => null, loginPath: null };
    const clientId = await register();
    const tokens = await exchange(codeOf(await authorize(clientId, "mail:read tasks:read")));
    assert.equal(tokens.scope, "tasks:read");
  });
});

describe("ログイン後の戻り先に認可画面を許す範囲（#905）", () => {
  it("/oauth/authorize? で始まる相対パスだけ", () => {
    assert.equal(isOAuthAuthorizeReturn("/oauth/authorize?client_id=a"), true);
    for (const bad of [
      "https://evil.example/oauth/authorize?x=1",
      "//evil.example/oauth/authorize?x=1",
      "/oauth/authorize",
      "/oauth/authorizeX?x=1",
      "/oauth/authorize?x=1\\evil",
      "/oauth/authorize?x=1\nSet-Cookie:a",
      `/oauth/authorize?${"a".repeat(2000)}`,
    ]) {
      assert.equal(isOAuthAuthorizeReturn(bad), false, bad);
      assert.equal(safeLanding(bad), "/map");
    }
  });
});
