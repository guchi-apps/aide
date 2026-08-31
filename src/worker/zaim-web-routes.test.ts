import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { checkZaimWebServerConfig, routeZaimWeb } from "./zaim-web-routes.ts";

afterEach(() => {
  delete process.env["AIDE_ZAIM_WRITE_SECRET"];
  delete process.env["AIDE_ZAIM_WEB_UPSTREAM_URL"];
});

describe("routeZaimWeb", () => {
  it("開くのは受け口1本と /health だけ", () => {
    assert.equal(routeZaimWeb("/api/zaim/payment/web"), "payment");
    assert.equal(routeZaimWeb("/health"), "health");
  });

  it("本体サーバーの他の口は開かない", () => {
    // MCP・OAuth・画面・公式APIでの登録は、サブPCに2組目を作らないため載せていない。
    for (const path of [
      "/mcp",
      "/oauth/token",
      "/status",
      "/api/zaim/payment",
      "/api/zaim/master",
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
