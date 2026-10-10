import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { checkZaimWebServerConfig, routeZaimWeb } from "./zaim-web-routes.ts";

afterEach(() => {
  delete process.env["AIDE_ZAIM_WRITE_SECRET"];
  delete process.env["AIDE_ZAIM_WEB_UPSTREAM_URL"];
});

describe("routeZaimWeb", () => {
  it("開くのは受け口3本と /health だけ", () => {
    assert.equal(routeZaimWeb("/api/zaim/payment/web"), "payment");
    assert.equal(routeZaimWeb("/api/zaim/payment/web/genre"), "genre-edit");
    assert.equal(routeZaimWeb("/api/zaim/payment/web/memo"), "memo-edit");
    assert.equal(routeZaimWeb("/health"), "health");
  });

  it("商品内訳の手動再取得（#600）は受付とジョブの状態の2経路だけ開く", () => {
    const id = "0b6e3a52-8c5d-4a39-9f0a-1d2c3b4a5e6f";
    assert.equal(routeZaimWeb("/api/zaim/receipt-detail/refresh"), "receipt-refresh");
    assert.equal(routeZaimWeb(`/api/zaim/receipt-detail/refresh/${id}`), "receipt-refresh-job");
    assert.equal(routeZaimWeb("/api/zaim/receipt-detail/refresh/../../payment"), "not-found");
    assert.equal(routeZaimWeb("/api/zaim/receipt-detail"), "not-found");
  });

  it("本体サーバーの他の口は開かない", () => {
    // MCP・OAuth・画面・公式APIでの登録は、サブPCに2組目を作らないため載せていない。
    for (const path of [
      "/mcp",
      "/oauth/token",
      "/status",
      "/api/zaim/payment",
      "/api/zaim/master",
      "/api/zaim/payment/web/memo/extra",
      "/api/money/summary",
      "/api/cache/zaim-balance",
      "/",
    ]) {
      assert.equal(routeZaimWeb(path), "not-found", path);
    }
  });
});

describe("checkZaimWebServerConfig", () => {
  it("シークレットが無ければ起動させない", () => {
    const result = checkZaimWebServerConfig();
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /AIDE_ZAIM_WRITE_SECRET/);
  });

  it("中継先URLが設定されていれば起動させない（VPS側の設定との取り違え）", () => {
    process.env["AIDE_ZAIM_WRITE_SECRET"] = "s3cret";
    process.env["AIDE_ZAIM_WEB_UPSTREAM_URL"] = "http://subpc:4748";
    const result = checkZaimWebServerConfig();
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /AIDE_ZAIM_WEB_UPSTREAM_URL/);
  });

  it("シークレットだけ設定されていれば起動してよい", () => {
    process.env["AIDE_ZAIM_WRITE_SECRET"] = "s3cret";
    assert.deepEqual(checkZaimWebServerConfig(), { ok: true });
  });
});
