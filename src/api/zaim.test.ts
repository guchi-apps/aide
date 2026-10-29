import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it, mock } from "node:test";

// 検査を通らない要求はZaimへ届かないが、記録の置き場だけは本番と分けておく。
const dir = await mkdtemp(join(tmpdir(), "aide-zaim-api-test-"));
process.env["AIDE_ZAIM_WEB_PAYMENT_LOG_PATH"] = join(dir, "zaim-web-payments.json");
process.env["AIDE_ZAIM_WEB_GENRE_EDIT_LOG_PATH"] = join(dir, "zaim-web-genre-edits.json");
const {
  handleZaimReceiptRefresh,
  handleZaimRetiredApi,
  handleZaimWebGenreEdit,
  handleZaimWebMemoEdit,
  handleZaimWebPayment,
} = await import("./zaim.ts");
const { isRetiredZaimApiPath, resolveZaimWriteSecret, zaimWriteSecret } = await import("./zaim.ts");
const { resetRateLimits } = await import("../auth/ratelimit.ts");
const { resetSharedTokenCacheForTest } = await import("../core/connectors/issue-deck/shared-tokens.ts");

/**
 * **Zaimへ実際にリクエストが飛ぶ経路はここでは扱わない。**
 * 認証・メソッド・設定の有無・入力検査という、Zaimへ届く前に決まるところだけをテストする。
 */

const SECRET = "test-only-zaim-write-secret";

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

// 認証の失敗は回数として積み上がる。テストの並び順で後続がロックされないよう毎回戻す。
beforeEach(() => {
  resetRateLimits();
});

const originalFetch = globalThis.fetch;

describe("AIDE_ZAIM_WRITE_SECRET の取得（aide#665）", () => {
  afterEach(() => {
    delete process.env["AIDE_ZAIM_WRITE_SECRET"];
    delete process.env["AIDE_ISSUE_DECK_URL"];
    delete process.env["SHARED_TOKEN_API_SECRET"];
    globalThis.fetch = originalFetch;
    resetSharedTokenCacheForTest();
  });

  it("未設定なら null", async () => {
    assert.equal(await resolveZaimWriteSecret(), null);
  });

  it("共有トークンAPIが未設定なら環境変数にフォールバックする", async () => {
    process.env["AIDE_ZAIM_WRITE_SECRET"] = SECRET;
    assert.equal(await resolveZaimWriteSecret(), SECRET);
  });

  it("共有トークンAPIから取得できればそちらを優先し、利用元は aide を名乗る", async () => {
    process.env["AIDE_ZAIM_WRITE_SECRET"] = SECRET;
    process.env["AIDE_ISSUE_DECK_URL"] = "https://deck.example.test";
    process.env["SHARED_TOKEN_API_SECRET"] = "shared-token-api-secret";
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      assert.equal(String(url), "https://deck.example.test/api/shared-tokens?name=AIDE_ZAIM_WRITE_SECRET");
      const headers = (init?.headers ?? {}) as Record<string, string>;
      assert.equal(headers["X-Shared-Token-Consumer"], "aide");
      return new Response(JSON.stringify({ name: "AIDE_ZAIM_WRITE_SECRET", value: "shared-value" }), { status: 200 });
    }) as typeof fetch;

    assert.equal(await resolveZaimWriteSecret(), "shared-value");
  });

  it("共有トークンAPIで取得できなければ環境変数へフォールバックする", async () => {
    process.env["AIDE_ZAIM_WRITE_SECRET"] = SECRET;
    process.env["AIDE_ISSUE_DECK_URL"] = "https://deck.example.test";
    process.env["SHARED_TOKEN_API_SECRET"] = "shared-token-api-secret";
    globalThis.fetch = (async () => new Response("", { status: 500 })) as typeof fetch;
    const warn = mock.method(console, "warn", () => {});
    try {
      assert.equal(await resolveZaimWriteSecret(), SECRET);
    } finally {
      warn.mock.restore();
    }
  });

  it("サブPCの受け口が読む zaimWriteSecret() は環境変数だけを見る", async () => {
    process.env["AIDE_ISSUE_DECK_URL"] = "https://deck.example.test";
    process.env["SHARED_TOKEN_API_SECRET"] = "shared-token-api-secret";
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response(JSON.stringify({ value: "shared-value" }), { status: 200 });
    }) as typeof fetch;
    assert.equal(zaimWriteSecret(), null);
    process.env["AIDE_ZAIM_WRITE_SECRET"] = SECRET;
    assert.equal(zaimWriteSecret(), SECRET);
    assert.equal(called, false);
  });
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

describe("廃止した公式APIの口（aide#714）", () => {
  it("/api/zaim/payment と /api/zaim/master だけが廃止の対象", () => {
    assert.equal(isRetiredZaimApiPath("/api/zaim/payment"), true);
    assert.equal(isRetiredZaimApiPath("/api/zaim/master"), true);
    assert.equal(isRetiredZaimApiPath("/api/zaim/payment/web"), false);
  });

  it("認証なしでも410と移行先を返す（Zaimへは何も送らない）", () => {
    for (const path of ["/api/zaim/payment", "/api/zaim/master"]) {
      const { res, captured } = fakeRes();
      handleZaimRetiredApi(path, res);
      assert.equal(captured.status, 410);
      const body = JSON.parse(captured.body) as Record<string, unknown>;
      assert.equal(body["kind"], "retired");
      assert.equal(typeof body["alternative"], "string");
    }
  });
});

/**
 * `POST /api/zaim/payment/web`（#214）。
 *
 * こちらもZaimへ届く前に決まるところだけを見る。**上の口との違いで押さえるのは2点。**
 * ZaimのOAuth設定を見ないこと（使うのはログイン状態だけ）と、必須の項目が増えていること。
 */
async function postWeb(body: unknown, authorization: string | null = `Bearer ${SECRET}`): Promise<Captured> {
  const { res, captured } = fakeRes();
  await handleZaimWebPayment(
    fakeReq("POST", typeof body === "string" ? body : JSON.stringify(body), authorization),
    res,
  );
  return captured;
}

const VALID_WEB_BODY = {
  requestId: "test:web:1",
  amount: 1200,
  date: "2026-08-19",
  name: "ピザ",
  place: "ドミノ・ピザ",
  categoryName: "食費",
  genreName: "外食",
  fromAccountId: 21678522,
};

describe("POST /api/zaim/payment/web", () => {
  it("シークレット未設定なら503", async () => {
    delete process.env["AIDE_ZAIM_WRITE_SECRET"];
    const result = await postWeb(VALID_WEB_BODY);
    assert.equal(result.status, 503);
  });

  it("シークレットが違えば401", async () => {
    process.env["AIDE_ZAIM_WRITE_SECRET"] = SECRET;
    assert.equal((await postWeb(VALID_WEB_BODY, "Bearer wrong")).status, 401);
  });

  it("POST以外は405（認証より先に見る）", async () => {
    const { res, captured } = fakeRes();
    await handleZaimWebPayment(fakeReq("GET", "", null), res);
    assert.equal(captured.status, 405);
  });

  it("ZaimのOAuth設定が無くても口は開く（使うのはログイン状態だけ）", async () => {
    // ここで503にすると、Zaimへ書ける環境（サブPC）なのに口が開かないことになる。
    process.env["AIDE_ZAIM_WRITE_SECRET"] = SECRET;
    const result = await postWeb({ ...VALID_WEB_BODY, name: undefined });
    assert.equal(result.status, 400, "OAuth未設定の503ではなく、入力検査まで進むこと");
    assert.match(result.body, /name/);
  });

  it("入力が不正なら400で、何が足りないかを返す", async () => {
    process.env["AIDE_ZAIM_WRITE_SECRET"] = SECRET;

    for (const key of ["place", "categoryName", "genreName", "fromAccountId"]) {
      const result = await postWeb({ ...VALID_WEB_BODY, [key]: undefined });
      assert.equal(result.status, 400, `${key} が無くても通ってしまいます`);
      assert.match(result.body, new RegExp(key));
    }
  });

  it("JSONとして読めなければ400", async () => {
    process.env["AIDE_ZAIM_WRITE_SECRET"] = SECRET;
    assert.equal((await postWeb("{壊れた")).status, 400);
  });
});

/**
 * `POST /api/zaim/payment/web/genre`（#273）。
 *
 * こちらも上と同じくZaimへ届く前に決まるところだけを見る。既存明細を対象にするため
 * `moneyId` が必須で、`name`・`place`・`fromAccountId` は受け取らない。
 */
async function postWebGenre(body: unknown, authorization: string | null = `Bearer ${SECRET}`): Promise<Captured> {
  const { res, captured } = fakeRes();
  await handleZaimWebGenreEdit(
    fakeReq("POST", typeof body === "string" ? body : JSON.stringify(body), authorization),
    res,
  );
  return captured;
}

const VALID_WEB_GENRE_BODY = {
  requestId: "test:genre:1",
  moneyId: 10228209053,
  amount: 1238,
  date: "2026-09-02",
  categoryName: "食費",
  genreName: "調理食品",
};

describe("POST /api/zaim/payment/web/genre", () => {
  it("シークレット未設定なら503", async () => {
    delete process.env["AIDE_ZAIM_WRITE_SECRET"];
    assert.equal((await postWebGenre(VALID_WEB_GENRE_BODY)).status, 503);
  });

  it("シークレットが違えば401", async () => {
    process.env["AIDE_ZAIM_WRITE_SECRET"] = SECRET;
    assert.equal((await postWebGenre(VALID_WEB_GENRE_BODY, "Bearer wrong")).status, 401);
  });

  it("POST以外は405（認証より先に見る）", async () => {
    const { res, captured } = fakeRes();
    await handleZaimWebGenreEdit(fakeReq("GET", "", null), res);
    assert.equal(captured.status, 405);
  });

  it("ZaimのOAuth設定が無くても口は開く（使うのはログイン状態だけ）", async () => {
    process.env["AIDE_ZAIM_WRITE_SECRET"] = SECRET;
    const result = await postWebGenre({ ...VALID_WEB_GENRE_BODY, categoryName: undefined });
    assert.equal(result.status, 400, "OAuth未設定の503ではなく、入力検査まで進むこと");
    assert.match(result.body, /categoryName/);
  });

  it("入力が不正なら400で、何が足りないかを返す", async () => {
    process.env["AIDE_ZAIM_WRITE_SECRET"] = SECRET;

    for (const key of ["moneyId", "date", "amount", "categoryName", "genreName"]) {
      const result = await postWebGenre({ ...VALID_WEB_GENRE_BODY, [key]: undefined });
      assert.equal(result.status, 400, `${key} が無くても通ってしまいます`);
      assert.match(result.body, new RegExp(key));
    }
  });

  it("JSONとして読めなければ400", async () => {
    process.env["AIDE_ZAIM_WRITE_SECRET"] = SECRET;
    assert.equal((await postWebGenre("{壊れた")).status, 400);
  });
});

/**
 * `POST /api/zaim/payment/web/memo`（#354）。
 *
 * こちらもZaimへ届く前に決まるところだけを見る。`comment` は必須（空文字はメモを消す指定として通る）で、
 * カテゴリの項目は受け取らない。
 */
async function postWebMemo(body: unknown, authorization: string | null = `Bearer ${SECRET}`): Promise<Captured> {
  const { res, captured } = fakeRes();
  await handleZaimWebMemoEdit(
    fakeReq("POST", typeof body === "string" ? body : JSON.stringify(body), authorization),
    res,
  );
  return captured;
}

const VALID_WEB_MEMO_BODY = {
  requestId: "test:memo:1",
  moneyId: 5001,
  amount: 1284,
  date: "2026-09-17",
  comment: "おにぎり 158円／牛乳 218円",
};

describe("POST /api/zaim/payment/web/memo", () => {
  it("シークレット未設定なら503", async () => {
    delete process.env["AIDE_ZAIM_WRITE_SECRET"];
    assert.equal((await postWebMemo(VALID_WEB_MEMO_BODY)).status, 503);
  });

  it("シークレットが違えば401", async () => {
    process.env["AIDE_ZAIM_WRITE_SECRET"] = SECRET;
    assert.equal((await postWebMemo(VALID_WEB_MEMO_BODY, "Bearer wrong")).status, 401);
  });

  it("POST以外は405（認証より先に見る）", async () => {
    const { res, captured } = fakeRes();
    await handleZaimWebMemoEdit(fakeReq("GET", "", null), res);
    assert.equal(captured.status, 405);
  });

  it("ZaimのOAuth設定が無くても口は開く（使うのはログイン状態だけ）", async () => {
    process.env["AIDE_ZAIM_WRITE_SECRET"] = SECRET;
    const result = await postWebMemo({ ...VALID_WEB_MEMO_BODY, comment: undefined });
    assert.equal(result.status, 400, "OAuth未設定の503ではなく、入力検査まで進むこと");
    assert.match(result.body, /comment/);
  });

  it("入力が不正なら400で、何が足りないかを返す", async () => {
    process.env["AIDE_ZAIM_WRITE_SECRET"] = SECRET;

    for (const key of ["requestId", "moneyId", "date", "amount", "comment"]) {
      const result = await postWebMemo({ ...VALID_WEB_MEMO_BODY, [key]: undefined });
      assert.equal(result.status, 400, `${key} が無くても通ってしまいます`);
      assert.match(result.body, new RegExp(key));
    }
  });

  it("上限を超えたメモは切らずに400で返す", async () => {
    process.env["AIDE_ZAIM_WRITE_SECRET"] = SECRET;
    const result = await postWebMemo({ ...VALID_WEB_MEMO_BODY, comment: "あ".repeat(101) });
    assert.equal(result.status, 400);
    assert.match(result.body, /100文字/);
  });

  it("JSONとして読めなければ400", async () => {
    process.env["AIDE_ZAIM_WRITE_SECRET"] = SECRET;
    assert.equal((await postWebMemo("{壊れた")).status, 400);
  });
});

describe("商品内訳の手動再取得 /api/zaim/receipt-detail/refresh（#600）", () => {
  const JOB_ID = "0b6e3a52-8c5d-4a39-9f0a-1d2c3b4a5e6f";
  const BODY = { moneyId: 9001, date: "2026-10-09", amount: 1543 };

  afterEach(() => {
    mock.restoreAll();
    delete process.env["AIDE_ZAIM_WEB_UPSTREAM_URL"];
  });

  async function call(
    method: string,
    jobId: string | null,
    body: unknown = null,
    authorization: string | null = `Bearer ${SECRET}`,
    headers: Record<string, string> = {},
  ): Promise<Captured & { json: Record<string, unknown> }> {
    const { res, captured } = fakeRes();
    const req = fakeReq(method, JSON.stringify(body), authorization);
    Object.assign(req.headers, headers);
    await handleZaimReceiptRefresh(req, res, jobId);
    return { ...captured, json: captured.body ? (JSON.parse(captured.body) as Record<string, unknown>) : {} };
  }

  it("受付は POST、状態の読み取りは GET だけ（405）", async () => {
    process.env["AIDE_ZAIM_WRITE_SECRET"] = SECRET;
    assert.equal((await call("GET", null)).status, 405);
    assert.equal((await call("POST", JOB_ID, BODY)).status, 405);
  });

  it("シークレット未設定は503、違えば401", async () => {
    delete process.env["AIDE_ZAIM_WRITE_SECRET"];
    assert.equal((await call("POST", null, BODY)).status, 503);
    process.env["AIDE_ZAIM_WRITE_SECRET"] = SECRET;
    assert.equal((await call("POST", null, BODY, "Bearer wrong")).status, 401);
    assert.equal((await call("GET", JOB_ID, null, null)).status, 401);
  });

  it("入力が不正なら400（Zaimも中継先も触らない）", async () => {
    process.env["AIDE_ZAIM_WRITE_SECRET"] = SECRET;
    process.env["AIDE_ZAIM_WEB_UPSTREAM_URL"] = "http://subpc:4748";
    const fetchMock = mock.method(globalThis, "fetch", async () => new Response("{}"));
    const got = await call("POST", null, { moneyId: 9001 });
    assert.equal(got.status, 400);
    assert.deepEqual((got.json["failure"] as { kind: string }).kind, "invalid");
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  it("中継先があればサブPCへ中継し、受付（202）をそのまま返す", async () => {
    process.env["AIDE_ZAIM_WRITE_SECRET"] = SECRET;
    process.env["AIDE_ZAIM_WEB_UPSTREAM_URL"] = "http://subpc:4748";
    const accepted = { ok: true, job: { jobId: JOB_ID, status: "running" }, deduplicated: false };
    const fetchMock = mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(accepted), { status: 202 }));

    const got = await call("POST", null, BODY);

    assert.equal(got.status, 202);
    assert.deepEqual(got.json, accepted);
    assert.equal(fetchMock.mock.callCount(), 1);
    assert.equal(String(fetchMock.mock.calls[0]?.arguments[0]), "http://subpc:4748/api/zaim/receipt-detail/refresh");
  });

  it("サブPCに繋がらなければ502 subpc_unreachable（取得の失敗とは別の種類）", async () => {
    process.env["AIDE_ZAIM_WRITE_SECRET"] = SECRET;
    process.env["AIDE_ZAIM_WEB_UPSTREAM_URL"] = "http://subpc:4748";
    mock.method(globalThis, "fetch", async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ECONNREFUSED" }) });
    });
    const got = await call("GET", JOB_ID);
    assert.equal(got.status, 502);
    assert.equal((got.json["failure"] as { kind: string }).kind, "subpc_unreachable");
  });

  it("中継されてきたリクエストは中継せず自分で処理する（無限に回さない）", async () => {
    process.env["AIDE_ZAIM_WRITE_SECRET"] = SECRET;
    process.env["AIDE_ZAIM_WEB_UPSTREAM_URL"] = "http://subpc:4748";
    const fetchMock = mock.method(globalThis, "fetch", async () => new Response("{}"));
    const got = await call("GET", JOB_ID, null, `Bearer ${SECRET}`, { "x-aide-zaim-web-forwarded": "1" });
    assert.equal(fetchMock.mock.callCount(), 0);
    assert.equal(got.status, 404);
  });

  it("受け口が知らないジョブは404 job_not_found（再起動で消えた場合に依頼し直せる）", async () => {
    process.env["AIDE_ZAIM_WRITE_SECRET"] = SECRET;
    const got = await call("GET", JOB_ID);
    assert.equal(got.status, 404);
    assert.deepEqual(got.json["failure"], {
      kind: "job_not_found",
      retryable: true,
      message: (got.json["failure"] as { message: string }).message,
    });
  });
});
