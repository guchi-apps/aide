import assert from "node:assert/strict";
import { basename } from "node:path";
import { afterEach, describe, it } from "node:test";
import { ZAIM_SESSION_EXPIRED } from "./errors.ts";
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

/**
 * 呼ばれたスクリプト名を順に記録しつつ、指定した結果を返す `deps`。
 *
 * 時計は自前で進める。`elapsePerCall` を渡すと1回の `exec` ごとにその時間が経過したことに
 * なり、`totalTimeout` の判断（残り時間で次を実行できるか）を実時間を待たずに試せる。
 */
function stubDeps(
  results: (string | Error)[],
  elapsePerCall = 0,
): ZaimScriptDeps & { calls: string[]; timeouts: number[] } {
  const calls: string[] = [];
  const timeouts: number[] = [];
  let clock = 0;
  return {
    calls,
    timeouts,
    async exec(script, options) {
      calls.push(basename(script));
      timeouts.push(options.timeout);
      clock += elapsePerCall;
      const result = results.shift();
      if (result === undefined) throw new Error("想定より多く呼ばれました");
      if (result instanceof Error) throw result;
      return { stdout: result };
    },
    async sleep() {
      // 待ち時間はテストでは不要。判断だけを見る。
    },
    now() {
      return clock;
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
      new RegExp(ZAIM_SESSION_EXPIRED),
    );
    assert.deepEqual(deps.calls, ["keep-alive.mjs", "auto-login.mjs", "keep-alive.mjs"]);
  });

  it("自動再ログイン自体が失敗したら、元の失効エラーを投げる", async () => {
    // 通知の分類は「セッション失効」のままであるべき。ログイン失敗に差し替えない。
    setCredentials(true);
    const deps = stubDeps([new Error(EXPIRED), new Error("追加認証が要求されました")]);
    await assert.rejects(
      () => runZaimScript(TARGET, { timeout: 1 }, deps),
      new RegExp(ZAIM_SESSION_EXPIRED),
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

/**
 * `totalTimeout` は一括更新（`refresh.ts`）のためにある。1回で最大45分待つため、
 * やり直しを無制限に許すと systemd の `TimeoutStartSec`（55分）に掛かって殺される（#190）。
 */
describe("runZaimScript: 呼び出し全体の上限（totalTimeout）", () => {
  /** 一括更新の実値に合わせる（`refresh.ts` の REFRESH_TIMEOUT_MS）。 */
  const TOTAL = 50 * 60_000;

  it("指定しなければ、実行ごとの上限をそのまま渡す", async () => {
    setCredentials(false);
    const deps = stubDeps([new Error(TRANSIENT), "ok"], 25 * 60_000);
    assert.equal(await runZaimScript(TARGET, { timeout: TOTAL }, deps), "ok");
    assert.deepEqual(deps.timeouts, [TOTAL, TOTAL]);
  });

  it("残り時間があればやり直し、その実行の上限を残りまで縮める", async () => {
    setCredentials(true);
    const deps = stubDeps([new Error(EXPIRED), "logged-in", "ok"], 2 * 60_000);
    assert.equal(
      await runZaimScript(TARGET, { timeout: TOTAL, totalTimeout: TOTAL }, deps),
      "ok",
    );
    assert.deepEqual(deps.calls, ["keep-alive.mjs", "auto-login.mjs", "keep-alive.mjs"]);
    // 失敗した実行と自動再ログインで4分使ったぶんだけ短くなる。
    assert.equal(deps.timeouts.at(-1), TOTAL - 4 * 60_000);
  });

  it("残り時間が足りなければやり直さず、失効のマーカーを保ったまま投げる", async () => {
    // 再ログインまでは行う。この実行では押し直せなくても、次の定期実行が通るようになる。
    setCredentials(true);
    const deps = stubDeps([new Error(EXPIRED), "logged-in"], 25 * 60_000);
    await assert.rejects(
      () => runZaimScript(TARGET, { timeout: TOTAL, totalTimeout: TOTAL }, deps),
      new RegExp(ZAIM_SESSION_EXPIRED),
    );
    assert.deepEqual(deps.calls, ["keep-alive.mjs", "auto-login.mjs"]);
  });

  it("一時的な失敗も、残り時間が足りなければ上限回数より前に諦める", async () => {
    setCredentials(false);
    const deps = stubDeps(
      Array.from({ length: MAX_ATTEMPTS }, () => new Error(TRANSIENT)),
      27 * 60_000,
    );
    await assert.rejects(
      () => runZaimScript(TARGET, { timeout: TOTAL, totalTimeout: TOTAL }, deps),
      /ERR_ADDRESS_UNREACHABLE/,
    );
    assert.equal(deps.calls.length, 2);
  });
});
