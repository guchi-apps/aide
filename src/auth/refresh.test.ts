import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

// 本番のトークンを汚さないよう、読み込み前に置き場を一時ファイルへ差し替える。
// STORE_PATH はモジュール読み込み時に確定するため、import より前に設定する必要がある。
const STATE_PATH = join(await mkdtemp(join(tmpdir(), "aide-auth-test-")), "oauth-state.json");
process.env["AIDE_AUTH_STATE_PATH"] = STATE_PATH;
const { addToken, consumeRefreshToken, findToken, readAuthSummary, resetCache } = await import("./store.ts");
const { handleToken } = await import("./oauth.ts");

const DAY_MS = 24 * 60 * 60 * 1000;

function tokenRecord(overrides: Partial<Parameters<typeof addToken>[0]> & { token: string; refreshToken: string }) {
  return {
    clientId: "client-1",
    expiresAt: Date.now() + 30 * DAY_MS,
    refreshExpiresAt: Date.now() + 180 * DAY_MS,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

afterEach(async () => {
  await writeFile(STATE_PATH, JSON.stringify({ clients: [], codes: [], tokens: [] }));
  resetCache();
});

describe("アクセストークンの失効後のリフレッシュ", () => {
  it("アクセストークンが切れても、他の保存が起きた後にリフレッシュトークンで更新できる", async () => {
    await addToken(
      tokenRecord({
        token: "expired-access",
        refreshToken: "still-valid-refresh",
        expiresAt: Date.now() - DAY_MS,
        refreshExpiresAt: Date.now() + 100 * DAY_MS,
      }),
    );
    // 別クライアントのトークン発行など、保存を伴う操作（prune が走る）。
    await addToken(tokenRecord({ token: "other-access", refreshToken: "other-refresh" }));

    assert.equal(await findToken("expired-access"), null, "アクセストークンとしては使えない");
    const consumed = await consumeRefreshToken("still-valid-refresh");
    assert.equal(consumed?.clientId, "client-1");
  });

  it("リフレッシュトークンの期限（180日）を過ぎたら拒否する", async () => {
    await addToken(
      tokenRecord({
        token: "old-access",
        refreshToken: "expired-refresh",
        expiresAt: Date.now() - 150 * DAY_MS,
        refreshExpiresAt: Date.now() - 1000,
      }),
    );
    assert.equal(await consumeRefreshToken("expired-refresh"), null);
  });

  it("使ったリフレッシュトークンは二度と通らない（ローテーション）", async () => {
    await addToken(tokenRecord({ token: "a", refreshToken: "used-refresh", expiresAt: 1 }));
    assert.notEqual(await consumeRefreshToken("used-refresh"), null);
    assert.equal(await consumeRefreshToken("used-refresh"), null);
  });

  it("リフレッシュトークンの期限も過ぎたレコードだけが保存時に落ちる", async () => {
    await addToken(
      tokenRecord({ token: "dead", refreshToken: "dead-refresh", expiresAt: 1, refreshExpiresAt: Date.now() - 1000 }),
    );
    await addToken(
      tokenRecord({ token: "waiting", refreshToken: "waiting-refresh", expiresAt: 1, refreshExpiresAt: Date.now() + DAY_MS }),
    );
    assert.equal(await consumeRefreshToken("dead-refresh"), null);
    assert.notEqual(await consumeRefreshToken("waiting-refresh"), null);
  });

  it("refreshExpiresAt を持たない古いレコードは、従来どおりアクセストークンと同時に切れる", async () => {
    const legacy = { ...tokenRecord({ token: "legacy", refreshToken: "legacy-refresh" }), expiresAt: Date.now() + DAY_MS };
    delete (legacy as { refreshExpiresAt?: number }).refreshExpiresAt;
    await addToken(legacy);
    await addToken(tokenRecord({ token: "other", refreshToken: "other-refresh" }));

    assert.notEqual(await findToken("legacy"), null, "期限内の古いレコードが保存で巻き込まれて消えない");
    assert.notEqual(await consumeRefreshToken("legacy-refresh"), null);
  });
});

describe("動作状況の集計", () => {
  it("リフレッシュ待ちのレコードは有効なトークンとして数えない", async () => {
    const alive = Date.now() + 5 * DAY_MS;
    await addToken(tokenRecord({ token: "live", refreshToken: "live-refresh", expiresAt: alive }));
    await addToken(tokenRecord({ token: "waiting", refreshToken: "waiting-refresh", expiresAt: Date.now() - DAY_MS }));

    const summary = await readAuthSummary();
    assert.equal(summary.tokens, 1);
    assert.equal(summary.nearestExpiryAt, new Date(alive).toISOString());
  });

  it("有効なトークンが無ければ最短の期限は null", async () => {
    await addToken(tokenRecord({ token: "waiting", refreshToken: "waiting-refresh", expiresAt: Date.now() - DAY_MS }));
    const summary = await readAuthSummary();
    assert.equal(summary.tokens, 0);
    assert.equal(summary.nearestExpiryAt, null);
  });
});

describe("トークンエンドポイントのリフレッシュ", () => {
  let server: Server | null = null;

  afterEach(async () => {
    const closing = server;
    server = null;
    if (closing) await new Promise((resolve) => closing.close(resolve));
  });

  async function post(form: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
    server = createServer((req, res) => void handleToken(req, res));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it("アクセストークン失効後のリフレッシュで、新しい組が発行され180日の期限を持つ", async () => {
    await addToken(
      tokenRecord({
        token: "expired-access",
        refreshToken: "valid-refresh",
        expiresAt: Date.now() - DAY_MS,
        refreshExpiresAt: Date.now() + 100 * DAY_MS,
      }),
    );

    const before = Date.now();
    const { status, body } = await post({ grant_type: "refresh_token", refresh_token: "valid-refresh" });
    assert.equal(status, 200);
    assert.equal(body["refresh_expires_in"], 180 * 24 * 60 * 60);

    const issued = await findToken(String(body["access_token"]));
    assert.ok(issued, "新しいアクセストークンが使える");
    assert.ok(
      issued.refreshExpiresAt !== undefined && issued.refreshExpiresAt >= before + 180 * DAY_MS,
      "新しいリフレッシュトークンは発行から180日の期限を持つ",
    );
    assert.equal(await consumeRefreshToken("valid-refresh"), null, "使ったリフレッシュトークンはローテーションで無効");
  });

  it("リフレッシュトークンの期限切れは invalid_grant で拒否する", async () => {
    await addToken(
      tokenRecord({
        token: "old-access",
        refreshToken: "expired-refresh",
        expiresAt: Date.now() - 150 * DAY_MS,
        refreshExpiresAt: Date.now() - 1000,
      }),
    );

    const { status, body } = await post({ grant_type: "refresh_token", refresh_token: "expired-refresh" });
    assert.equal(status, 400);
    assert.equal(body["error"], "invalid_grant");
  });
});
