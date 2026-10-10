import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEV_AUTH_DISABLED_CLIENT_ID } from "../types.ts";
import { connectionPermissionsTool as tool } from "./connection-permissions.ts";

const run = async (scopes: readonly string[] | undefined, clientId: string | null = "c1") => {
  const res = await tool.handler({}, { sessionId: null, scopes, clientId });
  return { res, body: JSON.parse(res.content[0]!.text) };
};

describe("aide_connection_permissions", () => {
  it("scopeを要求しない", () => {
    assert.equal(tool.requiredScopes, undefined);
  });

  it("書き込みありの接続", async () => {
    const { body, res } = await run(["work-reports:read", "work-reports:write"]);
    assert.equal(res.isError, undefined);
    assert.equal(body.authMode, "oauth");
    assert.equal(body.checks["work-reports:write"], true);
    assert.equal(body.checks["tasks:write"], false);
  });

  it("読み取りのみ", async () => {
    const { body } = await run(["work-reports:read"]);
    assert.equal(body.checks["work-reports:read"], true);
    assert.equal(body.checks["work-reports:write"], false);
  });

  it("空のscopeは正常応答で全てfalse", async () => {
    const { body, res } = await run([]);
    assert.equal(res.isError, undefined);
    assert.equal(body.status, "ok");
    assert.deepEqual(body.scopes, []);
    assert.ok(Object.values(body.checks).every((v) => v === false));
  });

  it("scopeが判定不能なら未許可にせずエラー", async () => {
    const { body, res } = await run(undefined);
    assert.equal(res.isError, true);
    assert.equal(body.status, "indeterminate");
    assert.equal(body.checks, undefined);
  });

  it("認証無効モードはauth-disabledと区別され、clientIdやトークンは出ない", async () => {
    const { body, res } = await run(["tasks:read"], DEV_AUTH_DISABLED_CLIENT_ID);
    assert.equal(body.authMode, "auth-disabled");
    assert.ok(!res.content[0]!.text.includes(DEV_AUTH_DISABLED_CLIENT_ID));
  });
});
