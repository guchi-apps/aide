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
const { handleMoneySummary, handleMoneyTransactions, readSecret } = await import("./read.ts");
const { writeCache } = await import("../core/cache/store.ts");
const { ZAIM_CACHE_KEY } = await import("../worker/jobs/zaim-sync.ts");
const { ZAIM_MONEY_CACHE_KEY } = await import("../worker/jobs/zaim-money-sync.ts");
const { resetSharedTokenCacheForTest } = await import("../core/connectors/issue-deck/shared-tokens.ts");

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

async function call(
  options: Parameters<typeof fakeReq>[0] = {},
  handler: typeof handleMoneySummary = handleMoneySummary,
): Promise<Captured> {
  const { res, captured } = fakeRes();
  await handler(fakeReq(options), res);
  return captured;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  delete process.env["AIDE_READ_SECRET"];
  delete process.env["AIDE_ISSUE_DECK_URL"];
  delete process.env["SHARED_TOKEN_API_SECRET"];
  globalThis.fetch = originalFetch;
  resetSharedTokenCacheForTest();
});

describe("readSecret", () => {
  it("未設定なら null", async () => {
    assert.equal(await readSecret(), null);
  });

  it("共有トークンAPIが未設定なら環境変数 AIDE_READ_SECRET にフォールバックする", async () => {
    process.env["AIDE_READ_SECRET"] = SECRET;
    assert.equal(await readSecret(), SECRET);
  });

  it("共有トークンAPIから取得できればそちらを優先する", async () => {
    process.env["AIDE_READ_SECRET"] = SECRET;
    process.env["AIDE_ISSUE_DECK_URL"] = "https://deck.example.test";
    process.env["SHARED_TOKEN_API_SECRET"] = "shared-token-api-secret";
    globalThis.fetch = (async (url: string | URL) => {
      assert.equal(String(url), "https://deck.example.test/api/shared-tokens?name=AIDE_READ_SECRET");
      return new Response(JSON.stringify({ name: "AIDE_READ_SECRET", value: "shared-value" }), { status: 200 });
    }) as typeof fetch;

    assert.equal(await readSecret(), "shared-value");
  });
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

describe("GET /api/money/transactions", () => {
  it("シークレット未設定なら503を返す（401とは分ける）", async () => {
    const got = await call({ authorization: `Bearer ${SECRET}` }, handleMoneyTransactions);
    assert.equal(got.status, 503);
    assert.match(JSON.parse(got.body).error, /AIDE_READ_SECRET/);
  });

  it("Authorization が無ければ401", async () => {
    process.env["AIDE_READ_SECRET"] = SECRET;
    assert.equal((await call({}, handleMoneyTransactions)).status, 401);
  });

  it("GET / HEAD 以外は405で Allow を返す", async () => {
    process.env["AIDE_READ_SECRET"] = SECRET;
    const got = await call({ method: "POST", authorization: `Bearer ${SECRET}` }, handleMoneyTransactions);
    assert.equal(got.status, 405);
    assert.equal(got.headers["Allow"], "GET, HEAD");
  });

  it("キャッシュが空でも200で empty: true を返す", async () => {
    process.env["AIDE_READ_SECRET"] = SECRET;
    await rm(join(cacheDir, `${ZAIM_MONEY_CACHE_KEY}.json`), { force: true });

    const got = await call({ authorization: `Bearer ${SECRET}` }, handleMoneyTransactions);
    assert.equal(got.status, 200);
    const body = JSON.parse(got.body);
    assert.equal(body.empty, true);
    assert.equal(body.fetchedAt, null);
    assert.deepEqual(body.entries, []);
  });

  it("キャッシュがあれば明細一覧と取得時刻・経過分数を返す", async () => {
    process.env["AIDE_READ_SECRET"] = SECRET;
    await writeCache(ZAIM_MONEY_CACHE_KEY, "test", {
      entries: [
        {
          id: 10228209053,
          date: "2026-09-02",
          amount: 1238,
          category: "食費",
          genre: "調理食品",
          account: "スマートレシート",
          toAccount: "",
          place: "ライフ 高槻城西店",
          name: "SS大盛りペペロ…",
          comment: "",
        },
      ],
    });

    const got = await call({ authorization: `Bearer ${SECRET}` }, handleMoneyTransactions);
    assert.equal(got.status, 200);
    assert.equal(got.headers["Cache-Control"], "no-store");
    assert.match(got.headers["Content-Type"] ?? "", /application\/json/);

    const body = JSON.parse(got.body);
    assert.equal(body.empty, false);
    assert.equal(body.entries[0].id, 10228209053);
    assert.equal(body.entries[0].account, "スマートレシート");
    assert.ok(!Number.isNaN(new Date(body.fetchedAt).getTime()));
    assert.ok(body.ageMinutes >= 0);
    assert.equal(typeof body.stale, "boolean");
  });
});

/**
 * 商品内訳の手動再取得（#600）の結果が、定期巡回のキャッシュへ重なるか。
 * 重ねるのは「同じ取引で、巡回より新しいもの」だけ。
 */
describe("GET /api/money/transactions: 手動再取得した商品内訳の重ね合わせ", () => {
  const item = (name: string, amount: number) => ({
    id: null,
    name,
    amount,
    quantity: null,
    unitPrice: null,
    discount: null,
    tax: null,
    category: "食費",
    genre: "食料品",
  });
  const base = {
    id: 9001,
    date: "2026-10-09",
    amount: 1543,
    category: "食費",
    genre: "食料品",
    account: "スマートレシート",
    toAccount: "",
    place: "スーパー",
    name: "牛乳",
    comment: "",
  };

  async function read(): Promise<{ entries: Array<Record<string, unknown>> }> {
    process.env["AIDE_READ_SECRET"] = SECRET;
    const got = await call({ authorization: `Bearer ${SECRET}` }, handleMoneyTransactions);
    return JSON.parse(got.body);
  }

  async function seed(snapshotEntry: Record<string, unknown>, override: Record<string, unknown> | null) {
    await writeCache(ZAIM_MONEY_CACHE_KEY, "test", { entries: [snapshotEntry, { ...base, id: 9002 }], months: ["202610"] });
    await rm(join(cacheDir, "zaim-money-detail-9001.json"), { force: true });
    if (override) await writeCache("zaim-money-detail-9001", "test", override);
  }

  const failedRow = { ...base, itemsStatus: "failed", itemsNote: "取得できませんでした" };
  const newer = new Date(Date.now() + 60_000).toISOString();
  const older = new Date(Date.now() - 60 * 60_000).toISOString();
  const fresh = {
    entry: {
      id: 9001,
      date: "2026-10-09",
      amount: 1543,
      itemsStatus: "complete",
      items: [item("牛乳", 298), item("パン", 1245)],
    },
    fetchedAt: newer,
  };

  it("巡回で failed だった取引に、より新しい complete の内訳を重ね、取得時刻を付ける", async () => {
    await seed(failedRow, fresh);
    const row = (await read()).entries[0]!;
    assert.equal(row["itemsStatus"], "complete");
    assert.equal((row["items"] as unknown[]).length, 2);
    assert.equal(row["itemsNote"], undefined, "巡回の失敗理由を引きずらない");
    assert.equal(row["itemsFetchedAt"], newer);
  });

  it("巡回のほうが新しければ重ねない（古い手動取得で巡回結果を上書きしない）", async () => {
    await seed(failedRow, { ...fresh, fetchedAt: older });
    const row = (await read()).entries[0]!;
    assert.equal(row["itemsStatus"], "failed");
    assert.equal(row["itemsFetchedAt"], undefined);
  });

  it("日付・金額が違う（別の取引になった）結果は重ねない", async () => {
    await seed(failedRow, { ...fresh, entry: { ...fresh.entry, amount: 1500 } });
    assert.equal((await read()).entries[0]!["itemsStatus"], "failed");
  });

  it("手動取得の結果が無い取引・内訳を持たない取引は巡回のまま返す", async () => {
    await seed(failedRow, null);
    const { entries } = await read();
    assert.equal(entries[0]!["itemsStatus"], "failed");
    assert.deepEqual(entries[1], { ...base, id: 9002 });
  });
});

/**
 * 受け取る量を減らす口（aide#785）。期間指定・304・gzip。
 * パラメータもヘッダーも無い呼び出しが従来どおり全件を返すことも確かめる。
 */
describe("GET /api/money/transactions: 期間指定・ETag・gzip（#785）", () => {
  const row = (id: number, date: string) => ({
    id,
    date,
    amount: 100,
    category: "食費",
    genre: "食料品",
    account: "財布",
    toAccount: "",
    place: "",
    name: "",
    comment: "",
  });

  async function seed(): Promise<void> {
    await writeCache(ZAIM_MONEY_CACHE_KEY, "test", {
      entries: [row(1, "2026-09-30"), row(2, "2026-10-01"), row(3, "2026-10-15"), row(4, "2026-10-31")],
      months: ["202609", "202610"],
    });
  }

  async function get(
    url: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; headers: Record<string, string>; raw: unknown }> {
    process.env["AIDE_READ_SECRET"] = SECRET;
    const captured: { status: number; headers: Record<string, string>; raw: unknown } = {
      status: 0,
      headers: {},
      raw: undefined,
    };
    const res = {
      writeHead(status: number, h?: Record<string, string>) {
        captured.status = status;
        captured.headers = h ?? {};
        return res;
      },
      end(body?: unknown) {
        captured.raw = body;
        return res;
      },
    };
    const req = { method: "GET", url, headers: { authorization: `Bearer ${SECRET}`, ...headers } };
    await handleMoneyTransactions(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    return captured;
  }

  it("パラメータ無しは従来どおり全件・全月を返し、range を付けない", async () => {
    await seed();
    const got = await get("/api/money/transactions");
    assert.equal(got.status, 200);
    const body = JSON.parse(got.raw as string);
    assert.equal(body.entries.length, 4);
    assert.deepEqual(body.months, ["202609", "202610"]);
    assert.equal(body.range, undefined);
    assert.equal(got.headers["Content-Encoding"], undefined);
  });

  it("期間指定で entries を絞り、months は期間に月まるごと入る月だけにする", async () => {
    await seed();
    const body = JSON.parse((await get("/api/money/transactions?from=2026-09-15&to=2026-10-31")).raw as string);
    assert.deepEqual(body.entries.map((e: { id: number }) => e.id), [1, 2, 3, 4]);
    // 9月は15日からしか見ていないので months から外す（範囲外の9月の明細を「消えた」と誤判定させない）
    assert.deepEqual(body.months, ["202610"]);
    assert.deepEqual(body.range, { from: "2026-09-15", to: "2026-10-31" });

    const recent = JSON.parse((await get("/api/money/transactions?from=2026-10-10")).raw as string);
    assert.deepEqual(recent.entries.map((e: { id: number }) => e.id), [3, 4]);
    assert.deepEqual(recent.months, []);
    assert.deepEqual(recent.range, { from: "2026-10-10", to: null });

    const until = JSON.parse((await get("/api/money/transactions?to=2026-09-30")).raw as string);
    assert.deepEqual(until.entries.map((e: { id: number }) => e.id), [1]);
    assert.deepEqual(until.months, ["202609"]);
  });

  it("不正な期間は400", async () => {
    await seed();
    for (const q of ["from=2026-13-01", "to=20261001", "from=2026-02-30", "from=2026-10-02&to=2026-10-01"]) {
      const got = await get(`/api/money/transactions?${q}`);
      assert.equal(got.status, 400, q);
      assert.ok(JSON.parse(got.raw as string).error, q);
    }
  });

  it("If-None-Match が一致すれば本文無しの304を返し、鮮度ヘッダーは付ける", async () => {
    await seed();
    const first = await get("/api/money/transactions");
    const etag = first.headers["ETag"]!;
    assert.match(etag, /^W\/"/);
    assert.ok(first.headers["X-AIDE-Fetched-At"]);
    assert.ok(first.headers["X-AIDE-Age-Minutes"] !== undefined);
    assert.ok(first.headers["X-AIDE-Stale"] === "true" || first.headers["X-AIDE-Stale"] === "false");

    const second = await get("/api/money/transactions", { "if-none-match": etag });
    assert.equal(second.status, 304);
    assert.equal(second.raw, undefined);
    assert.equal(second.headers["ETag"], etag);
    assert.equal(second.headers["X-AIDE-Fetched-At"], first.headers["X-AIDE-Fetched-At"]);

    // 期間が違えば別のETag
    const ranged = await get("/api/money/transactions?from=2026-10-01", { "if-none-match": etag });
    assert.equal(ranged.status, 200);
    assert.notEqual(ranged.headers["ETag"], etag);
  });

  it("巡回し直す・手動再取得の内訳が重なるとETagが変わる", async () => {
    await seed();
    const before = (await get("/api/money/transactions")).headers["ETag"];
    await writeCache(ZAIM_MONEY_CACHE_KEY, "test", {
      entries: [row(1, "2026-09-30"), { ...row(2, "2026-10-01"), itemsStatus: "failed" }],
      months: ["202609", "202610"],
    });
    const afterSync = (await get("/api/money/transactions")).headers["ETag"];
    assert.notEqual(afterSync, before);

    await writeCache("zaim-money-detail-2", "test", {
      entry: { id: 2, date: "2026-10-01", amount: 100, itemsStatus: "complete", items: [] },
      fetchedAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const afterRefresh = await get("/api/money/transactions", { "if-none-match": afterSync! });
    assert.equal(afterRefresh.status, 200, "手動再取得の差し替えを304で隠さない");
    await rm(join(cacheDir, "zaim-money-detail-2.json"), { force: true });
  });

  it("Accept-Encoding: gzip なら圧縮して返す（q=0 は圧縮しない）", async () => {
    await seed();
    const { gunzipSync } = await import("node:zlib");
    const got = await get("/api/money/transactions", { "accept-encoding": "br, gzip" });
    assert.equal(got.status, 200);
    assert.equal(got.headers["Content-Encoding"], "gzip");
    assert.equal(got.headers["Vary"], "Accept-Encoding");
    const body = JSON.parse(gunzipSync(got.raw as Buffer).toString("utf8"));
    assert.equal(body.entries.length, 4);

    const refused = await get("/api/money/transactions", { "accept-encoding": "gzip;q=0" });
    assert.equal(refused.headers["Content-Encoding"], undefined);
    assert.equal(JSON.parse(refused.raw as string).entries.length, 4);
  });
});
