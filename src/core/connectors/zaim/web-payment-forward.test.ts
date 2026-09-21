import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  ZAIM_WEB_FORWARDED_HEADER,
  ZAIM_WEB_FORWARD_TIMEOUT_MS,
  ZAIM_WEB_GENRE_EDIT_FORWARD_TIMEOUT_MS,
  ZAIM_WEB_MEMO_EDIT_FORWARD_TIMEOUT_MS,
  forwardZaimWebGenreEdit,
  forwardZaimWebMemoEdit,
  forwardZaimWebPayment,
  probeZaimWebUpstream,
  zaimWebUpstreamUrl,
} from "./web-payment-forward.ts";
import { WEB_PAYMENT_TIMEOUT_MS, type ZaimWebPaymentInput } from "./web-payment.ts";
import { WEB_GENRE_EDIT_TIMEOUT_MS, type ZaimWebGenreEditInput } from "./web-genre-edit.ts";
import { WEB_MEMO_EDIT_TIMEOUT_MS, type ZaimWebMemoEditInput } from "./web-memo-edit.ts";

const INPUT: ZaimWebPaymentInput = {
  requestId: "asset-manager:receipt-item:1",
  amount: 1880,
  date: "2026-08-29",
  name: "ピザ",
  place: "ドミノ・ピザ",
  categoryName: "食費",
  genreName: "外食",
  fromAccountId: 21678522,
};

const GENRE_EDIT_INPUT: ZaimWebGenreEditInput = {
  requestId: "asset-manager:genre-suggestion:1",
  moneyId: 10228209053,
  amount: 1238,
  date: "2026-09-02",
  categoryName: "食費",
  genreName: "調理食品",
};

const MEMO_EDIT_INPUT: ZaimWebMemoEditInput = {
  requestId: "asset-manager:zaim-memo:5001:abc123",
  moneyId: 5001,
  amount: 1284,
  date: "2026-09-17",
  comment: "おにぎり 158円／牛乳 218円",
};

/** JSONを返すだけの `fetch` を作る。 */
function jsonFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

/** `fetch` が投げる失敗を作る（実際の失敗と同じく cause に code が入れ子で入る）。 */
function throwingFetch(code: string): typeof fetch {
  return (async () => {
    throw new TypeError("fetch failed", { cause: new Error("boom", { cause: { code } }) });
  }) as unknown as typeof fetch;
}

const OPTIONS = { baseUrl: "http://subpc:4748", secret: "s3cret" };

describe("zaimWebUpstreamUrl", () => {
  afterEach(() => {
    delete process.env["AIDE_ZAIM_WEB_UPSTREAM_URL"];
  });

  it("未設定・空文字は null（中継しない）", () => {
    assert.equal(zaimWebUpstreamUrl(), null);
    process.env["AIDE_ZAIM_WEB_UPSTREAM_URL"] = "   ";
    assert.equal(zaimWebUpstreamUrl(), null);
  });

  it("末尾のスラッシュを落とす", () => {
    process.env["AIDE_ZAIM_WEB_UPSTREAM_URL"] = "http://subpc:4748/";
    assert.equal(zaimWebUpstreamUrl(), "http://subpc:4748");
  });
});

describe("probeZaimWebUpstream", () => {
  afterEach(() => {
    delete process.env["AIDE_ZAIM_WEB_UPSTREAM_URL"];
  });

  it("未設定なら叩かずに「未設定」を返す", async () => {
    const never = (async () => {
      throw new Error("叩いてはいけない");
    }) as unknown as typeof fetch;
    assert.deepEqual(await probeZaimWebUpstream({ fetchImpl: never }), {
      ok: false,
      detail: "未設定",
    });
  });

  it("/health を叩き、通れば ok", async () => {
    process.env["AIDE_ZAIM_WEB_UPSTREAM_URL"] = "http://subpc:4748";
    let seen = "";
    const fetchImpl = (async (url: string) => {
      seen = url;
      return new Response("ok\n", { status: 200 });
    }) as unknown as typeof fetch;
    assert.deepEqual(await probeZaimWebUpstream({ fetchImpl }), { ok: true, detail: "" });
    assert.equal(seen, "http://subpc:4748/health");
  });

  it("失敗しても中継先のURLを画面へ出さない", async () => {
    process.env["AIDE_ZAIM_WEB_UPSTREAM_URL"] = "http://subpc.tailnet-example.ts.net:4748";
    const failing = (async () => {
      throw new TypeError("fetch failed to http://subpc.tailnet-example.ts.net:4748/health", {
        cause: new Error("boom", { cause: { code: "ECONNREFUSED" } }),
      });
    }) as unknown as typeof fetch;
    const result = await probeZaimWebUpstream({ fetchImpl: failing });
    assert.deepEqual(result, { ok: false, detail: "ECONNREFUSED" });
    assert.doesNotMatch(result.detail, /tailnet-example/);
  });
});

describe("forwardZaimWebPayment", () => {
  it("中継先のURL・認証・ループ止めのヘッダを付けて送る", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ ok: true, duplicated: false }), { status: 200 });
    }) as unknown as typeof fetch;

    await forwardZaimWebPayment(INPUT, { ...OPTIONS, fetchImpl });

    assert.ok(seen);
    const sent = seen as unknown as { url: string; init: RequestInit };
    assert.equal(sent.url, "http://subpc:4748/api/zaim/payment/web");
    const headers = sent.init.headers as Record<string, string>;
    assert.equal(headers["authorization"], "Bearer s3cret");
    // これが無いと、受け口の設定次第で2台のあいだを永久に往復しうる。
    assert.equal(headers[ZAIM_WEB_FORWARDED_HEADER], "1");
    assert.deepEqual(JSON.parse(sent.init.body as string), INPUT);
  });

  it("打ち切りは画面の操作より必ず長く待つ", () => {
    assert.ok(ZAIM_WEB_FORWARD_TIMEOUT_MS > WEB_PAYMENT_TIMEOUT_MS);
  });

  it("成功をそのまま戻し、moneyId は常に null", async () => {
    const outcome = await forwardZaimWebPayment(INPUT, {
      ...OPTIONS,
      fetchImpl: jsonFetch(200, {
        ok: true,
        duplicated: false,
        registered: { date: "2026-08-29", amount: 1880, name: "ピザ", accountName: "楽天カード" },
      }),
    });
    assert.deepEqual(outcome, {
      ok: true,
      moneyId: null,
      duplicated: false,
      registered: {
        date: "2026-08-29",
        amount: 1880,
        name: "ピザ",
        place: "",
        genre: "",
        accountName: "楽天カード",
        comment: "",
      },
    });
  });

  it("duplicated と registered:null をそのまま戻す", async () => {
    const outcome = await forwardZaimWebPayment(INPUT, {
      ...OPTIONS,
      fetchImpl: jsonFetch(200, { ok: true, duplicated: true, registered: null }),
    });
    assert.deepEqual(outcome, { ok: true, moneyId: null, duplicated: true, registered: null });
  });

  it("相手が返した kind を潰さない（conflict を再送可能な分類へ倒さない）", async () => {
    const outcome = await forwardZaimWebPayment(INPUT, {
      ...OPTIONS,
      fetchImpl: jsonFetch(409, { ok: false, kind: "conflict", error: "結果が確定していません" }),
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.kind, "conflict");
    assert.equal(outcome.ok === false && outcome.reason, "結果が確定していません");
  });

  it("接続できなければ rejected（Zaimには何も登録されていない）", async () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH"]) {
      const outcome = await forwardZaimWebPayment(INPUT, {
        ...OPTIONS,
        fetchImpl: throwingFetch(code),
      });
      assert.equal(outcome.ok, false);
      assert.equal(outcome.ok === false && outcome.kind, "rejected", code);
      assert.match(outcome.ok === false ? outcome.reason : "", new RegExp(code));
    }
  });

  it("打ち切り・応答待ちでの切断は failed（登録されたか分からない）", async () => {
    const aborted = (async () => {
      throw new DOMException("The operation was aborted", "TimeoutError");
    }) as unknown as typeof fetch;
    const outcome = await forwardZaimWebPayment(INPUT, { ...OPTIONS, fetchImpl: aborted });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.kind, "failed");

    const reset = await forwardZaimWebPayment(INPUT, {
      ...OPTIONS,
      fetchImpl: throwingFetch("ECONNRESET"),
    });
    assert.equal(reset.ok === false && reset.kind, "failed");
  });

  it("認証・設定の誤りは rejected（画面を開く前に断られている）", async () => {
    for (const status of [401, 429, 503]) {
      const outcome = await forwardZaimWebPayment(INPUT, {
        ...OPTIONS,
        fetchImpl: jsonFetch(status, { error: "unauthorized" }),
      });
      assert.equal(outcome.ok === false && outcome.kind, "rejected", String(status));
    }
  });

  it("読めない応答は failed に倒す（登録された可能性を消さない）", async () => {
    const broken = (async () => new Response("<html>502</html>", { status: 502 })) as unknown as typeof fetch;
    const outcome = await forwardZaimWebPayment(INPUT, { ...OPTIONS, fetchImpl: broken });
    assert.equal(outcome.ok === false && outcome.kind, "failed");
  });
});

describe("forwardZaimWebGenreEdit", () => {
  it("中継先のURL・認証・ループ止めのヘッダを付けて送る", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ ok: true, moneyId: GENRE_EDIT_INPUT.moneyId, duplicated: false }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    await forwardZaimWebGenreEdit(GENRE_EDIT_INPUT, { ...OPTIONS, fetchImpl });

    assert.ok(seen);
    const sent = seen as unknown as { url: string; init: RequestInit };
    assert.equal(sent.url, "http://subpc:4748/api/zaim/payment/web/genre");
    const headers = sent.init.headers as Record<string, string>;
    assert.equal(headers["authorization"], "Bearer s3cret");
    assert.equal(headers[ZAIM_WEB_FORWARDED_HEADER], "1");
    assert.deepEqual(JSON.parse(sent.init.body as string), GENRE_EDIT_INPUT);
  });

  it("打ち切りは画面の操作より必ず長く待つ", () => {
    assert.ok(ZAIM_WEB_GENRE_EDIT_FORWARD_TIMEOUT_MS > WEB_GENRE_EDIT_TIMEOUT_MS);
  });

  it("成功をそのまま戻す。moneyId は相手の応答、無ければ渡した値", async () => {
    const withMoneyId = await forwardZaimWebGenreEdit(GENRE_EDIT_INPUT, {
      ...OPTIONS,
      fetchImpl: jsonFetch(200, { ok: true, moneyId: 999, duplicated: false }),
    });
    assert.deepEqual(withMoneyId, { ok: true, moneyId: 999, duplicated: false });

    const withoutMoneyId = await forwardZaimWebGenreEdit(GENRE_EDIT_INPUT, {
      ...OPTIONS,
      fetchImpl: jsonFetch(200, { ok: true, duplicated: true }),
    });
    assert.deepEqual(withoutMoneyId, { ok: true, moneyId: GENRE_EDIT_INPUT.moneyId, duplicated: true });
  });

  it("相手が返した kind を潰さない（conflict を再送可能な分類へ倒さない）", async () => {
    const outcome = await forwardZaimWebGenreEdit(GENRE_EDIT_INPUT, {
      ...OPTIONS,
      fetchImpl: jsonFetch(409, { ok: false, kind: "conflict", error: "結果が確定していません" }),
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.kind, "conflict");
    assert.equal(outcome.ok === false && outcome.reason, "結果が確定していません");
  });

  it("接続できなければ rejected（Zaimには何も変更されていない）", async () => {
    const outcome = await forwardZaimWebGenreEdit(GENRE_EDIT_INPUT, {
      ...OPTIONS,
      fetchImpl: throwingFetch("ECONNREFUSED"),
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.kind, "rejected");
  });

  it("打ち切り・応答待ちでの切断は failed（変更されたか分からない）", async () => {
    const outcome = await forwardZaimWebGenreEdit(GENRE_EDIT_INPUT, {
      ...OPTIONS,
      fetchImpl: throwingFetch("ECONNRESET"),
    });
    assert.equal(outcome.ok === false && outcome.kind, "failed");
  });

  it("認証・設定の誤りは rejected（画面を開く前に断られている）", async () => {
    const outcome = await forwardZaimWebGenreEdit(GENRE_EDIT_INPUT, {
      ...OPTIONS,
      fetchImpl: jsonFetch(401, { error: "unauthorized" }),
    });
    assert.equal(outcome.ok === false && outcome.kind, "rejected");
  });

  it("読めない応答は failed に倒す（変更された可能性を消さない）", async () => {
    const broken = (async () => new Response("<html>502</html>", { status: 502 })) as unknown as typeof fetch;
    const outcome = await forwardZaimWebGenreEdit(GENRE_EDIT_INPUT, { ...OPTIONS, fetchImpl: broken });
    assert.equal(outcome.ok === false && outcome.kind, "failed");
  });
});

describe("forwardZaimWebMemoEdit", () => {
  it("メモ用のパスへ、認証・ループ止めのヘッダと本文を付けて送る", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ ok: true, moneyId: MEMO_EDIT_INPUT.moneyId, duplicated: false }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    await forwardZaimWebMemoEdit(MEMO_EDIT_INPUT, { ...OPTIONS, fetchImpl });

    assert.ok(seen);
    const sent = seen as unknown as { url: string; init: RequestInit };
    assert.equal(sent.url, "http://subpc:4748/api/zaim/payment/web/memo");
    const headers = sent.init.headers as Record<string, string>;
    assert.equal(headers["authorization"], "Bearer s3cret");
    assert.equal(headers[ZAIM_WEB_FORWARDED_HEADER], "1");
    assert.deepEqual(JSON.parse(sent.init.body as string), MEMO_EDIT_INPUT);
  });

  it("打ち切りは画面の操作より必ず長く待つ", () => {
    assert.ok(ZAIM_WEB_MEMO_EDIT_FORWARD_TIMEOUT_MS > WEB_MEMO_EDIT_TIMEOUT_MS);
  });

  it("成功をそのまま戻す。moneyId は相手の応答、無ければ渡した値", async () => {
    const withMoneyId = await forwardZaimWebMemoEdit(MEMO_EDIT_INPUT, {
      ...OPTIONS,
      fetchImpl: jsonFetch(200, { ok: true, moneyId: 999, duplicated: false }),
    });
    assert.deepEqual(withMoneyId, { ok: true, moneyId: 999, duplicated: false });

    const withoutMoneyId = await forwardZaimWebMemoEdit(MEMO_EDIT_INPUT, {
      ...OPTIONS,
      fetchImpl: jsonFetch(200, { ok: true, duplicated: true }),
    });
    assert.deepEqual(withoutMoneyId, { ok: true, moneyId: MEMO_EDIT_INPUT.moneyId, duplicated: true });
  });

  it("相手が返した kind を潰さない（rejected の取り違え検知も、conflict もそのまま）", async () => {
    const rejected = await forwardZaimWebMemoEdit(MEMO_EDIT_INPUT, {
      ...OPTIONS,
      fetchImpl: jsonFetch(422, { ok: false, kind: "rejected", error: "金額が一致しません" }),
    });
    assert.equal(rejected.ok === false && rejected.kind, "rejected");
    assert.equal(rejected.ok === false && rejected.reason, "金額が一致しません");

    const conflict = await forwardZaimWebMemoEdit(MEMO_EDIT_INPUT, {
      ...OPTIONS,
      fetchImpl: jsonFetch(409, { ok: false, kind: "conflict", error: "結果が確定していません" }),
    });
    assert.equal(conflict.ok === false && conflict.kind, "conflict");
  });

  it("接続できなければ rejected、応答待ちでの切断は failed", async () => {
    const refused = await forwardZaimWebMemoEdit(MEMO_EDIT_INPUT, {
      ...OPTIONS,
      fetchImpl: throwingFetch("ECONNREFUSED"),
    });
    assert.equal(refused.ok === false && refused.kind, "rejected");

    const reset = await forwardZaimWebMemoEdit(MEMO_EDIT_INPUT, {
      ...OPTIONS,
      fetchImpl: throwingFetch("ECONNRESET"),
    });
    assert.equal(reset.ok === false && reset.kind, "failed");
  });

  it("受け口が無い（404）のは画面を開く前に断られている＝rejected", async () => {
    // 受け口を持たない古いサブPCへ中継した場合。呼び出し側は404を notImplemented として扱う。
    const outcome = await forwardZaimWebMemoEdit(MEMO_EDIT_INPUT, {
      ...OPTIONS,
      fetchImpl: jsonFetch(404, { error: "not found" }),
    });
    assert.equal(outcome.ok === false && outcome.kind, "rejected");
  });

  it("読めない応答は failed に倒す（変更された可能性を消さない）", async () => {
    const broken = (async () => new Response("<html>502</html>", { status: 502 })) as unknown as typeof fetch;
    const outcome = await forwardZaimWebMemoEdit(MEMO_EDIT_INPUT, { ...OPTIONS, fetchImpl: broken });
    assert.equal(outcome.ok === false && outcome.kind, "failed");
  });
});
