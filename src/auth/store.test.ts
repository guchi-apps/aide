import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

/**
 * 状態ファイルの置き場は読み込み時に決まるため、import の前に一時ディレクトリへ向ける
 * （本番の `data/auth/oauth-state.json` を汚さない）。
 */
const dir = await mkdtemp(join(tmpdir(), "aide-auth-store-"));
const statePath = join(dir, "oauth-state.json");
process.env["AIDE_AUTH_STATE_PATH"] = statePath;
const store = await import("./store.ts");

const FAR_FUTURE = Date.now() + 60 * 60 * 1000;

function token(n: number) {
  return {
    token: `access-${n}`,
    refreshToken: `refresh-${n}`,
    clientId: "client",
    expiresAt: FAR_FUTURE,
    createdAt: new Date().toISOString(),
  };
}

async function readState() {
  return JSON.parse(await readFile(statePath, "utf8")) as {
    clients: unknown[];
    codes: { code: string }[];
    tokens: { token: string }[];
  };
}

describe("OAuth状態の保存", () => {
  beforeEach(async () => {
    await rm(statePath, { force: true });
    store.resetCache();
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("同時に発行したトークンがすべて残る", async () => {
    // 直列化が無いと、後から保存した側が先の追加を上書きして消す。
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.addToken(token(i))));

    const saved = await readState();
    assert.equal(saved.tokens.length, 20);
    for (let i = 0; i < 20; i++) {
      assert.ok(await store.findToken(`access-${i}`), `access-${i} が消えている`);
    }
  });

  it("重なった保存が例外にならず、一時ファイルも残らない", async () => {
    // 一時ファイル名が固定だと、先に rename した側に持ち去られて ENOENT になる。
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => store.addToken(token(i))));
    assert.deepEqual(
      results.filter((r) => r.status === "rejected"),
      [],
    );
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
  });

  it("トークン発行とリフレッシュが重なっても、発行したトークンが消えない", async () => {
    await store.addToken(token(0));
    store.resetCache();

    const [, rotated] = await Promise.all([store.addToken(token(1)), store.consumeRefreshToken("refresh-0")]);

    assert.equal(rotated?.token, "access-0");
    assert.equal(await store.findToken("access-0"), null);
    assert.ok(await store.findToken("access-1"));
    assert.deepEqual(
      (await readState()).tokens.map((t) => t.token),
      ["access-1"],
    );
  });

  it("同じ認可コードを同時に引き換えても、取り出せるのは1回だけ", async () => {
    await store.addCode({
      code: "code-1",
      clientId: "client",
      redirectUri: "https://example.com/cb",
      codeChallenge: "challenge",
      resource: null,
      expiresAt: FAR_FUTURE,
    });

    const taken = await Promise.all([store.consumeCode("code-1"), store.consumeCode("code-1")]);

    assert.equal(taken.filter((c) => c !== null).length, 1);
  });

  it("同じリフレッシュトークンを同時に使っても、ローテーションできるのは1回だけ", async () => {
    await store.addToken(token(0));

    const rotated = await Promise.all([store.consumeRefreshToken("refresh-0"), store.consumeRefreshToken("refresh-0")]);

    assert.equal(rotated.filter((t) => t !== null).length, 1);
  });

  it("保存が失敗しても、後続の更新は止まらない", async () => {
    await store.addToken(token(0));
    // 状態ファイルのある場所をディレクトリにすると、rename が失敗する。
    await rm(statePath, { force: true });
    await mkdir(statePath);
    await assert.rejects(store.addToken(token(1)));
    await rm(statePath, { recursive: true, force: true });

    await store.addToken(token(2));

    // 失敗した保存は反映されず、ディスクと同じ状態のまま次へ進める。
    assert.equal(await store.findToken("access-1"), null);
    assert.ok(await store.findToken("access-0"));
    assert.ok(await store.findToken("access-2"));
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
  });

  it("読み取りが保存と重なっても、古い内容でキャッシュを上書きしない", async () => {
    await store.addToken(token(0));
    store.resetCache();

    // キャッシュが空の状態で、読み取りと保存を同時に始める。
    const [, found] = await Promise.all([store.addToken(token(1)), store.findToken("access-0")]);

    assert.ok(found);
    assert.ok(await store.findToken("access-1"));
  });
});
