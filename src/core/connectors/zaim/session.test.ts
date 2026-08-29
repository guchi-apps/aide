import assert from "node:assert/strict";
import { basename } from "node:path";
import { afterEach, describe, it } from "node:test";
import { ZAIM_AUTO_RELOGIN_FAILED, ZAIM_SESSION_EXPIRED } from "./errors.ts";
import { MAX_ATTEMPTS } from "./retry.ts";
import { type ZaimScriptDeps, runZaimScript, zaimScriptPath } from "./session.ts";

/**
 * `runZaimScript` の回復判断のテスト。
 *
 * 実行本体はPlaywrightを起動する子プロセスなので、`deps.exec` を差し替えて
 * 「どのスクリプトが何回呼ばれたか」だけを見る。待ち時間も潰してテストを速く保つ。
 */

const TARGET = zaimScriptPath("keep-alive.mjs");
const TRANSIENT = "page.goto: net::ERR_ADDRESS_UNREACHABLE at https://example.test/";
const EXPIRED = `Error: ${ZAIM_SESSION_EXPIRED}:https://example.test/`;

/** 呼ばれたスクリプト名を順に記録しつつ、指定した結果を返す `deps`。 */
function stubDeps(results: (string | Error)[]): ZaimScriptDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async exec(script) {
      calls.push(basename(script));
      const result = results.shift();
      if (result === undefined) throw new Error("想定より多く呼ばれました");
      if (result instanceof Error) throw result;
      return { stdout: result };
    },
    async sleep() {
      // 待ち時間はテストでは不要。判断だけを見る。
    },
  };
}

const originalEnv = { ...process.env };

function setCredentials(configured: boolean): void {
  if (configured) {
    process.env["ZAIM_EMAIL"] = "someone@example.test";
    process.env["ZAIM_PASSWORD"] = "dummy-password";
  } else {
    delete process.env["ZAIM_EMAIL"];
    delete process.env["ZAIM_PASSWORD"];
  }
}

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("runZaimScript: 一時的な失敗の再試行", () => {
  it("成功したらその場で返す", async () => {
    setCredentials(false);
    const deps = stubDeps(["ok"]);
    assert.equal(await runZaimScript(TARGET, { timeout: 1 }, deps), "ok");
    assert.deepEqual(deps.calls, ["keep-alive.mjs"]);
  });

  it("一時的な失敗は間を空けてやり直す", async () => {
    // #63: ネットワーク断で1回落ちただけでセッションを失っていた。
    setCredentials(false);
    const deps = stubDeps([new Error(TRANSIENT), "ok"]);
    assert.equal(await runZaimScript(TARGET, { timeout: 1 }, deps), "ok");
    assert.deepEqual(deps.calls, ["keep-alive.mjs", "keep-alive.mjs"]);
  });

  it("やり直す回数には上限があり、最後の失敗を投げる", async () => {
    setCredentials(false);
    const deps = stubDeps(Array.from({ length: MAX_ATTEMPTS }, () => new Error(TRANSIENT)));
    await assert.rejects(() => runZaimScript(TARGET, { timeout: 1 }, deps), /ERR_ADDRESS_UNREACHABLE/);
    assert.equal(deps.calls.length, MAX_ATTEMPTS);
  });
});

describe("runZaimScript: セッション失効", () => {
  it("資格情報が無ければやり直さず、失効のマーカーを保ったまま投げる", async () => {
    // マーカーが消えると、通知側が「手動ログインが必要な失敗」として扱えなくなる。
    setCredentials(false);
    const deps = stubDeps([new Error(EXPIRED)]);
    await assert.rejects(
      () => runZaimScript(TARGET, { timeout: 1 }, deps),
      new RegExp(ZAIM_SESSION_EXPIRED),
    );
    assert.deepEqual(deps.calls, ["keep-alive.mjs"]);
  });

  it("自動再ログインを試していない失敗には、自動失敗のマーカーを付けない", async () => {
    // #191: 付けると、資格情報が無いだけの環境の失敗まで「自動でも直らない」と通知される。
    setCredentials(false);
    const deps = stubDeps([new Error(EXPIRED)]);
    await assert.rejects(
      () => runZaimScript(TARGET, { timeout: 1 }, deps),
      (cause: Error) => !cause.message.includes(ZAIM_AUTO_RELOGIN_FAILED),
    );
  });

  it("資格情報があれば自動再ログインを挟んでやり直す", async () => {
    setCredentials(true);
    const deps = stubDeps([new Error(EXPIRED), "logged-in", "ok"]);
    assert.equal(await runZaimScript(TARGET, { timeout: 1 }, deps), "ok");
    assert.deepEqual(deps.calls, ["keep-alive.mjs", "auto-login.mjs", "keep-alive.mjs"]);
  });

  it("自動再ログインは1回きり。再ログイン後も失効するなら諦める", async () => {
    // 資格情報が古い場合に、ログインと失効を延々と往復させない。
    setCredentials(true);
    const deps = stubDeps([new Error(EXPIRED), "logged-in", new Error(EXPIRED)]);
    await assert.rejects(
      () => runZaimScript(TARGET, { timeout: 1 }, deps),
      // 自動では直らなかったので、両方のマーカーが載る。
      (cause: Error) =>
        cause.message.includes(ZAIM_SESSION_EXPIRED) &&
        cause.message.includes(ZAIM_AUTO_RELOGIN_FAILED),
    );
    assert.deepEqual(deps.calls, ["keep-alive.mjs", "auto-login.mjs", "keep-alive.mjs"]);
  });

  it("自動再ログイン自体が失敗したら、元の失効エラーにマーカーを足して投げる", async () => {
    // 通知の分類は「セッション失効」のままであるべき。ログイン失敗に差し替えない。
    // そのうえで #191 のため「自動でも直らなかった」ことを伝えられるようにする。
    setCredentials(true);
    const deps = stubDeps([new Error(EXPIRED), new Error("追加認証が要求されました")]);
    await assert.rejects(
      () => runZaimScript(TARGET, { timeout: 1 }, deps),
      (cause: Error) =>
        cause.message.includes(EXPIRED) && cause.message.includes(ZAIM_AUTO_RELOGIN_FAILED),
    );
    assert.deepEqual(deps.calls, ["keep-alive.mjs", "auto-login.mjs"]);
  });

  it("一時的な失敗を挟んでから失効した場合も自動再ログインへ進む", async () => {
    setCredentials(true);
    const deps = stubDeps([new Error(TRANSIENT), new Error(EXPIRED), "logged-in", "ok"]);
    assert.equal(await runZaimScript(TARGET, { timeout: 1 }, deps), "ok");
    assert.deepEqual(deps.calls, [
      "keep-alive.mjs",
      "keep-alive.mjs",
      "auto-login.mjs",
      "keep-alive.mjs",
    ]);
  });
});
