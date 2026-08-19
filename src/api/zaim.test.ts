import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

// 検査を通らない要求はZaimへ届かないが、記録の置き場だけは本番と分けておく。
const dir = await mkdtemp(join(tmpdir(), "aide-zaim-api-test-"));
process.env["AIDE_ZAIM_PAYMENT_LOG_PATH"] = join(dir, "zaim-payments.json");
const { handleZaimMaster, handleZaimPayment } = await import("./zaim.ts");
const { resetRateLimits } = await import("../auth/ratelimit.ts");

/**
 * **Zaimへ実際にリクエストが飛ぶ経路はここでは扱わない。**
 * 認証・メソッド・設定の有無・入力検査という、Zaimへ届く前に決まるところだけをテストする。
 * 検査を通る本体（`createZaimPayment`）は `core/connectors/zaim/write.test.ts`。
 */

const SECRET = "test-only-zaim-write-secret";

const OAUTH_NAMES = [
  "AIDE_ZAIM_CONSUMER_KEY",
  "AIDE_ZAIM_CONSUMER_SECRET",
  "AIDE_ZAIM_ACCESS_TOKEN",
  "AIDE_ZAIM_ACCESS_TOKEN_SECRET",
] as const;

function setOAuthEnv(configured: boolean): void {
  for (const name of OAUTH_NAMES) {
    if (configured) process.env[name] = "dummy";
    else delete process.env[name];
  }
}

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

// 認証の失敗は回数として積み上がる。テストの並び順で後続がロックされないよう毎回戻す。
beforeEach(() => {
  resetRateLimits();
});

interface Captured {
  status: number;
  body: string;
}

function fakeRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: "" };
  const res = {
    writeHead(status: number) {
      captured.status = status;
      return res;
    },
    end(body?: string) {
      captured.body = body ?? "";
      return res;
    },
  };
  return { res: res as unknown as ServerResponse, captured };
}

function fakeReq(method: string, body: string, authorization: string | null): IncomingMessage {
  const headers: Record<string, string> = {};
  if (authorization !== null) headers["authorization"] = authorization;
  return {
    method,
    headers,
    // 回数制限は送信元ごとに数えるため、実物と同じく socket を持たせる。
    socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body, "utf8");
    },
  } as unknown as IncomingMessage;
}

async function post(body: unknown, authorization: string | null = `Bearer ${SECRET}`): Promise<Captured> {
  const { res, captured } = fakeRes();
  await handleZaimPayment(fakeReq("POST", typeof body === "string" ? body : JSON.stringify(body), authorization), res);
  return captured;
}

const VALID_BODY = {
  requestId: "test:1",
  amount: 1200,
  date: "2026-08-19",
  categoryId: 101,
  genreId: 10101,
};

describe("POST /api/zaim/payment", () => {
  it("シークレット未設定なら503（認証の失敗とは分ける）", async () => {
    delete process.env["AIDE_ZAIM_WRITE_SECRET"];
    const result = await post(VALID_BODY);
    assert.equal(result.status, 503);
    assert.match(result.body, /AIDE_ZAIM_WRITE_SECRET/);
  });

  it("シークレットが違えば401", async () => {
    process.env["AIDE_ZAIM_WRITE_SECRET"] = SECRET;
    setOAuthEnv(true);
    assert.equal((await post(VALID_BODY, "Bearer wrong")).status, 401);
    assert.equal((await post(VALID_BODY, null)).status, 401);
  });

  it("失敗が続けば429で締め出す（公開URLからも届くため）", async () => {
    process.env["AIDE_ZAIM_WRITE_SECRET"] = SECRET;
    setOAuthEnv(true);
    for (let attempt = 0; attempt < 5; attempt += 1) await post(VALID_BODY, "Bearer wrong");

    // 正しい鍵でもロック中は通さない。
    assert.equal((await post(VALID_BODY)).status, 429);
  });

  it("POST以外は405（認証より先に見る）", async () => {
    const { res, captured } = fakeRes();
    await handleZaimPayment(fakeReq("GET", "", null), res);
    assert.equal(captured.status, 405);
  });

  it("ZaimのOAuth設定が揃っていなければ503", async () => {
    process.env["AIDE_ZAIM_WRITE_SECRET"] = SECRET;
    setOAuthEnv(false);
    const result = await post(VALID_BODY);
    assert.equal(result.status, 503);
    assert.match(result.body, /AIDE_ZAIM_/);
  });

  it("JSONとして読めなければ400", async () => {
    process.env["AIDE_ZAIM_WRITE_SECRET"] = SECRET;
    setOAuthEnv(true);
    assert.equal((await post("{壊れた")).status, 400);
  });

  it("入力が不正なら400で、何が足りないかを返す", async () => {
    process.env["AIDE_ZAIM_WRITE_SECRET"] = SECRET;
    setOAuthEnv(true);

    const noRequestId = await post({ ...VALID_BODY, requestId: undefined });
    assert.equal(noRequestId.status, 400);
    assert.match(noRequestId.body, /requestId/);

    const badAmount = await post({ ...VALID_BODY, amount: 0 });
    assert.equal(badAmount.status, 400);
    assert.match(badAmount.body, /amount/);
  });
});

describe("GET /api/zaim/master", () => {
  it("GET以外は405", async () => {
    const { res, captured } = fakeRes();
    await handleZaimMaster(fakeReq("POST", "", null), res);
    assert.equal(captured.status, 405);
  });

  it("シークレットが違えば401", async () => {
    process.env["AIDE_ZAIM_WRITE_SECRET"] = SECRET;
    setOAuthEnv(true);
    const { res, captured } = fakeRes();
    await handleZaimMaster(fakeReq("GET", "", "Bearer wrong"), res);
    assert.equal(captured.status, 401);
  });

  it("ZaimのOAuth設定が揃っていなければ503（Zaimへは問い合わせない）", async () => {
    process.env["AIDE_ZAIM_WRITE_SECRET"] = SECRET;
    setOAuthEnv(false);
    const { res, captured } = fakeRes();
    await handleZaimMaster(fakeReq("GET", "", `Bearer ${SECRET}`), res);
    assert.equal(captured.status, 503);
  });
});
