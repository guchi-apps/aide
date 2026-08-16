import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { secretMatches } from "./secret.ts";

// 本番のキャッシュを汚さないよう、読み込み前に置き場を一時ディレクトリへ差し替える。
// CACHE_DIR はモジュール読み込み時に確定するため、import より前に設定する必要がある。
const cacheDir = await mkdtemp(join(tmpdir(), "aide-read-test-"));
process.env["AIDE_CACHE_DIR"] = cacheDir;
const { handleMoneySummary } = await import("./read.ts");
const { writeCache } = await import("../core/cache/store.ts");
const { ZAIM_CACHE_KEY } = await import("../worker/jobs/zaim-sync.ts");

const SECRET = "test-only-read-secret";

interface Captured {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * `writeHead` / `end` だけを記録する最小のスタブ。
 * 読み取りAPIはリクエストボディを読まないため、実サーバーを立てなくても経路を通せる。
 */
function fakeRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, headers: {}, body: "" };
  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status;
      captured.headers = headers ?? {};
      return res;
    },
    end(body?: string) {
      captured.body = body ?? "";
      return res;
    },
  };
  return { res: res as unknown as ServerResponse, captured };
}

function fakeReq(options: { method?: string; authorization?: string } = {}): IncomingMessage {
  const headers: Record<string, string> = {};
  if (options.authorization !== undefined) headers["authorization"] = options.authorization;
  return { method: options.method ?? "GET", headers } as unknown as IncomingMessage;
}

async function call(options: Parameters<typeof fakeReq>[0] = {}): Promise<Captured> {
  const { res, captured } = fakeRes();
  await handleMoneySummary(fakeReq(options), res);
  return captured;
}

afterEach(() => {
  delete process.env["AIDE_READ_SECRET"];
});

describe("シークレット照合", () => {
  it("一致する場合のみ true", () => {
    assert.equal(secretMatches("s3cret", "s3cret"), true);
    assert.equal(secretMatches("wrong", "s3cre"), false);
  });

  it("長さが違っても例外を投げずに false を返す", () => {
    assert.equal(secretMatches("", "s3cret"), false);
    assert.equal(secretMatches("s3cret-longer", "s3cret"), false);
  });
});

describe("GET /api/money/summary", () => {
  it("シークレット未設定なら503を返す（401とは分ける）", async () => {
    const got = await call({ authorization: `Bearer ${SECRET}` });
    assert.equal(got.status, 503);
    assert.match(JSON.parse(got.body).error, /AIDE_READ_SECRET/);
  });

  it("Authorization が無ければ401", async () => {
    process.env["AIDE_READ_SECRET"] = SECRET;
    assert.equal((await call()).status, 401);
  });

  it("シークレットが違えば401", async () => {
    process.env["AIDE_READ_SECRET"] = SECRET;
    const got = await call({ authorization: "Bearer wrong-secret" });
    assert.equal(got.status, 401);
    // 応答に期待値そのものが漏れていないこと。
    assert.ok(!got.body.includes(SECRET));
  });

  it("Bearer 以外のスキームは受け付けない", async () => {
    process.env["AIDE_READ_SECRET"] = SECRET;
    assert.equal((await call({ authorization: `Basic ${SECRET}` })).status, 401);
  });

  it("GET / HEAD 以外は405で Allow を返す（認証より先に判定する）", async () => {
    process.env["AIDE_READ_SECRET"] = SECRET;
    const got = await call({ method: "POST", authorization: `Bearer ${SECRET}` });
    assert.equal(got.status, 405);
    assert.equal(got.headers["Allow"], "GET, HEAD");
  });

  it("キャッシュが空でも200で empty: true を返す", async () => {
    process.env["AIDE_READ_SECRET"] = SECRET;
    await rm(join(cacheDir, `${ZAIM_CACHE_KEY}.json`), { force: true });

    const got = await call({ authorization: `Bearer ${SECRET}` });
    assert.equal(got.status, 200);
    const body = JSON.parse(got.body);
    assert.equal(body.empty, true);
    assert.equal(body.fetchedAt, null);
  });

  it("キャッシュがあれば残高・保有銘柄と取得時刻・経過分数を返す", async () => {
    process.env["AIDE_READ_SECRET"] = SECRET;
    await writeCache(ZAIM_CACHE_KEY, "test", {
      balances: [{ name: "テスト銀行", amount: 1000 }],
      holdings: [
        { account: "テスト証券", name: "テスト投信", amount: 2000, occurrence: 1, occurrenceCount: 1 },
      ],
    });

    const got = await call({ authorization: `Bearer ${SECRET}` });
    assert.equal(got.status, 200);
    assert.equal(got.headers["Cache-Control"], "no-store");
    assert.match(got.headers["Content-Type"] ?? "", /application\/json/);

    const body = JSON.parse(got.body);
    assert.equal(body.empty, false);
    assert.equal(body.balances[0].name, "テスト銀行");
    assert.equal(body.holdings[0].name, "テスト投信");
    assert.ok(!Number.isNaN(new Date(body.fetchedAt).getTime()));
    assert.ok(body.ageMinutes >= 0);
    // 呼び出し側が鮮度を判断できるよう、経過情報を必ず添える。
    assert.equal(typeof body.stale, "boolean");
  });
});
