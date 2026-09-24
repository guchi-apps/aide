import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

// 置き場は読み込み時に決まるため、import の前に一時ディレクトリへ向ける。
const dir = await mkdtemp(join(tmpdir(), "aide-mobile-token-"));
const path = join(dir, "mobile-tokens.json");
process.env["AIDE_MOBILE_TOKEN_PATH"] = path;
const tokens = await import("./mobile-token.ts");

describe("モバイル向けトークン", () => {
  beforeEach(async () => {
    await rm(path, { force: true });
    tokens.resetMobileTokenCache();
  });
  after(() => rm(dir, { recursive: true, force: true }));

  it("発行したトークンで引け、ファイルには平文を残さない（600）", async () => {
    const { token } = await tokens.issueMobileToken("me@example.com");
    assert.equal((await tokens.findMobileToken(token))?.email, "me@example.com");
    assert.equal(await tokens.findMobileToken("違う値"), null);
    assert.equal(await tokens.findMobileToken(""), null);

    assert.ok(!(await readFile(path, "utf8")).includes(token));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });

  it("期限を過ぎたトークンは通らない", async () => {
    const { token, expiresAt } = await tokens.issueMobileToken("me@example.com", 1_000);
    assert.equal(expiresAt, 1_000 + tokens.TOKEN_TTL_MS);
    assert.ok(await tokens.findMobileToken(token, expiresAt - 1));
    assert.equal(await tokens.findMobileToken(token, expiresAt), null);
  });

  it("失効させると以後通らず、他のトークンは残る", async () => {
    const a = await tokens.issueMobileToken("me@example.com");
    const b = await tokens.issueMobileToken("me@example.com");
    assert.equal(await tokens.revokeMobileToken(a.token), true);
    assert.equal(await tokens.revokeMobileToken(a.token), false);
    assert.equal(await tokens.findMobileToken(a.token), null);
    assert.ok(await tokens.findMobileToken(b.token));
  });

  it("再起動（キャッシュ破棄）後もファイルから読める", async () => {
    const { token } = await tokens.issueMobileToken("me@example.com");
    tokens.resetMobileTokenCache();
    assert.ok(await tokens.findMobileToken(token));
  });
});
