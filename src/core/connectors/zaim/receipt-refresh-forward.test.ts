import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { forwardReceiptRefresh, receiptRefreshJobId } from "./receipt-refresh-forward.ts";

const OPTIONS = { baseUrl: "http://subpc:4748/", secret: "s3cret" };

function reply(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as typeof fetch;
}

function refused(code: string): typeof fetch {
  return (async () => {
    throw new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code }) });
  }) as typeof fetch;
}

describe("receiptRefreshJobId", () => {
  it("UUIDのジョブIDだけを取り出す", () => {
    const id = "0b6e3a52-8c5d-4a39-9f0a-1d2c3b4a5e6f";
    assert.equal(receiptRefreshJobId(`/api/zaim/receipt-detail/refresh/${id}`), id);
    for (const path of [
      "/api/zaim/receipt-detail/refresh",
      "/api/zaim/receipt-detail/refresh/",
      "/api/zaim/receipt-detail/refresh/../x",
      "/api/zaim/receipt-detail/refresh/abc/def",
      "/api/zaim/receipt-detail/refresh/ZZZZZZZZZZ",
    ]) {
      assert.equal(receiptRefreshJobId(path), null, path);
    }
  });
});

describe("forwardReceiptRefresh", () => {
  it("POST は認証・中継ヘッダ・本文を付けて送り、受付の応答をそのまま通す", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const accepted = { ok: true, job: { jobId: "j1", status: "running" }, deduplicated: false };
    const result = await forwardReceiptRefresh(
      { method: "POST", body: { moneyId: 9001, date: "2026-10-09", amount: 1543 } },
      {
        ...OPTIONS,
        fetchImpl: (async (url: string, init: RequestInit) => {
          seen = { url, init };
          return new Response(JSON.stringify(accepted), { status: 202 });
        }) as unknown as typeof fetch,
      },
    );
    assert.deepEqual(result, { status: 202, body: accepted });
    assert.equal(seen!.url, "http://subpc:4748/api/zaim/receipt-detail/refresh");
    const headers = seen!.init.headers as Record<string, string>;
    assert.equal(headers["authorization"], "Bearer s3cret");
    assert.equal(headers["x-aide-zaim-web-forwarded"], "1");
  });

  it("GET はジョブIDをパスへ付け、ジョブの失敗（取得失敗・job_not_found）を作り替えずに通す", async () => {
    const failed = { ok: true, job: { jobId: "j1", status: "failed", failure: { kind: "session_expired" } } };
    assert.deepEqual(
      await forwardReceiptRefresh({ method: "GET", jobId: "j1" }, { ...OPTIONS, fetchImpl: reply(200, failed) }),
      { status: 200, body: failed },
    );
    const missing = { ok: false, failure: { kind: "job_not_found", retryable: true, message: "m" } };
    assert.deepEqual(
      await forwardReceiptRefresh({ method: "GET", jobId: "j1" }, { ...OPTIONS, fetchImpl: reply(404, missing) }),
      { status: 404, body: missing },
    );
  });

  it("受付の拒否（busy）もそのまま通す", async () => {
    const busy = { ok: false, failure: { kind: "busy", retryable: true, message: "m" } };
    assert.deepEqual(
      await forwardReceiptRefresh({ method: "POST", body: {} }, { ...OPTIONS, fetchImpl: reply(429, busy) }),
      { status: 429, body: busy },
    );
  });

  it("サブPCが止まっている・届かない場合は subpc_unreachable（取得は始まっていない）", async () => {
    for (const code of ["ECONNREFUSED", "EHOSTUNREACH", "ENOTFOUND"]) {
      const result = await forwardReceiptRefresh({ method: "POST", body: {} }, { ...OPTIONS, fetchImpl: refused(code) });
      assert.equal(result.status, 502);
      assert.deepEqual(
        (result.body["failure"] as { kind: string; retryable: boolean }).kind,
        "subpc_unreachable",
        code,
      );
    }
  });

  it("応答待ちでの切断は subpc_timeout（受付済みか分からないと伝える）", async () => {
    const result = await forwardReceiptRefresh(
      { method: "POST", body: {} },
      { ...OPTIONS, fetchImpl: refused("UND_ERR_SOCKET") },
    );
    const failure = result.body["failure"] as { kind: string; message: string };
    assert.equal(failure.kind, "subpc_timeout");
    assert.match(failure.message, /受付済みかどうかは分かりません/);
  });

  it("サブPCがシークレット不一致・未更新（404）で断る場合は subpc_rejected（再試行不可）", async () => {
    for (const status of [401, 403, 404, 405, 503]) {
      const result = await forwardReceiptRefresh(
        { method: "POST", body: {} },
        { ...OPTIONS, fetchImpl: reply(status, { error: "x" }) },
      );
      assert.equal(result.status, 502, String(status));
      assert.deepEqual(result.body["failure"], {
        kind: "subpc_rejected",
        retryable: false,
        message: (result.body["failure"] as { message: string }).message,
      });
    }
  });

  it("JSONでない応答は subpc_bad_response", async () => {
    const result = await forwardReceiptRefresh(
      { method: "GET", jobId: "j1" },
      { ...OPTIONS, fetchImpl: reply(500, "<html>") },
    );
    assert.equal((result.body["failure"] as { kind: string }).kind, "subpc_bad_response");
  });
});
