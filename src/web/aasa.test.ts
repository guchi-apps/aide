import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aasa, handleAasa, AASA_PATH } from "./aasa.ts";

function fakeRes() {
  const out: { status?: number; headers?: Record<string, string>; body?: string } = {};
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      out.status = status;
      out.headers = headers;
      return res;
    },
    end(body?: string) {
      out.body = body;
    },
  };
  return { res: res as never, out };
}

describe("apple-app-site-association", () => {
  it("Team IDからApp IDを組み立て、認証・APIを除外する", () => {
    const body = aasa("ABCDE12345") as any;
    const detail = body.applinks.details[0];
    assert.deepEqual(detail.appIDs, ["ABCDE12345.com.gucchii.AIDEios"]);
    assert.deepEqual(detail.components.slice(0, 3), [
      { "/": "/status/auth/*", exclude: true },
      { "/": "/auth/*", exclude: true },
      { "/": "/api/*", exclude: true },
    ]);
    assert.deepEqual(detail.components[3], { "/": "/*" });
  });

  it("application/json で200を返す", () => {
    const { res, out } = fakeRes();
    assert.equal(handleAasa("GET", AASA_PATH, res, "ABCDE12345"), true);
    assert.equal(out.status, 200);
    assert.equal(out.headers!["Content-Type"], "application/json");
    assert.ok(JSON.parse(out.body!).applinks);
  });

  it("Team ID未設定なら404", () => {
    const { res, out } = fakeRes();
    assert.equal(handleAasa("GET", AASA_PATH, res, ""), true);
    assert.equal(out.status, 404);
  });

  it("別のパスやPOSTは担当しない", () => {
    const { res } = fakeRes();
    assert.equal(handleAasa("GET", "/x", res, "A"), false);
    assert.equal(handleAasa("POST", AASA_PATH, res, "A"), false);
  });
});
