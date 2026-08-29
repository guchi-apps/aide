import assert from "node:assert/strict";
import { basename } from "node:path";
import { afterEach, describe, it } from "node:test";
import { ZAIM_SESSION_EXPIRED } from "./errors.ts";
import { refreshZaimOnlineAccounts } from "./refresh.ts";
import type { ZaimScriptDeps } from "./session.ts";

/**
 * 一括更新がセッション失効から自力で回復するかのテスト（#190）。
 *
 * 以前はここだけ `execFile` を直呼びしており、失効すると自動再ログインを試さないまま
 * 落ちていた。そのぶん「データを更新する」が押されず、65分後の巡回が前回更新時点の
 * 残高を当日の値として記録していた。実行本体はPlaywrightを起動する子プロセスなので、
 * `deps.exec` を差し替えて「どのスクリプトが何回呼ばれたか」だけを見る。
 */

const EXPIRED = `Error: ${ZAIM_SESSION_EXPIRED}:https://example.test/`;

/** 押下に成功したときのスクリプトの出力。 */
const PRESSED = JSON.stringify({
  pressed: true,
  accounts: [{ name: "ゆうちょ銀行", lastUpdatedAt: "08/29 22:35", previousLastUpdatedAt: "08/28 22:35", advanced: true }],
  waitedMs: 2_400_000,
  timedOut: false,
});

function stubDeps(results: (string | Error)[]): ZaimScriptDeps & { calls: string[] } {
  const calls: string[] = [];
  let clock = 0;
  return {
    calls,
    async exec(script) {
      calls.push(basename(script));
      // 失効は押す前後の早い段階で分かる。やり直せる残り時間がある状態を再現する。
      clock += 2 * 60_000;
      const result = results.shift();
      if (result === undefined) throw new Error("想定より多く呼ばれました");
      if (result instanceof Error) throw result;
      return { stdout: result };
    },
    async sleep() {},
    now() {
      return clock;
    },
  };
}

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("refreshZaimOnlineAccounts", () => {
  it("資格情報があれば、失効しても自動再ログインを挟んで押し直す", async () => {
    process.env["ZAIM_EMAIL"] = "someone@example.test";
    process.env["ZAIM_PASSWORD"] = "dummy-password";

    const deps = stubDeps([new Error(EXPIRED), "logged-in", PRESSED]);
    const result = await refreshZaimOnlineAccounts(deps);

    assert.deepEqual(deps.calls, ["refresh.mjs", "auto-login.mjs", "refresh.mjs"]);
    assert.equal(result.pressed, true);
    assert.equal(result.accounts.length, 1);
  });

  it("資格情報が無ければ、失効のマーカーを保ったまま投げる", async () => {
    // マーカーが消えると、通知側が「手動ログインが必要な失敗」として扱えなくなる。
    delete process.env["ZAIM_EMAIL"];
    delete process.env["ZAIM_PASSWORD"];

    const deps = stubDeps([new Error(EXPIRED)]);
    await assert.rejects(
      () => refreshZaimOnlineAccounts(deps),
      new RegExp(ZAIM_SESSION_EXPIRED),
    );
    assert.deepEqual(deps.calls, ["refresh.mjs"]);
  });

  it("応答が壊れていれば失敗として扱う", async () => {
    const deps = stubDeps([JSON.stringify({ pressed: true })]);
    await assert.rejects(() => refreshZaimOnlineAccounts(deps), /応答が不正/);
  });
});
