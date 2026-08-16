import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ZAIM_SESSION_EXPIRED } from "./errors.ts";
import { MAX_ATTEMPTS, isRetriableZaimFailure, readZaimCredentials, retryDelayMs } from "./retry.ts";

describe("isRetriableZaimFailure", () => {
  it("一時的な失敗はやり直す", () => {
    // #63 でセッションを失う引き金になった実際のメッセージ。
    assert.equal(
      isRetriableZaimFailure("page.goto: net::ERR_ADDRESS_UNREACHABLE at https://zaim.net/home"),
      true,
    );
    assert.equal(isRetriableZaimFailure("Timeout 60000ms exceeded."), true);
    assert.equal(isRetriableZaimFailure("Playwright is not installed."), true);
  });

  it("セッション失効はやり直さない", () => {
    // やり直しても同じ結果になる。再ログインするまで直らない。
    assert.equal(isRetriableZaimFailure(`Error: ${ZAIM_SESSION_EXPIRED}:https://example.test/`), false);
  });

  it("execFile の失敗のようにstderr全文が載っていても判定できる", () => {
    const message = [
      "Command failed: /usr/bin/node /home/user/apps/aide/.../keep-alive.mjs",
      `❌ Zaimのセッション維持に失敗しました Error: ${ZAIM_SESSION_EXPIRED}:https://example.test/`,
    ].join("\n");
    assert.equal(isRetriableZaimFailure(message), false);
  });
});

describe("retryDelayMs", () => {
  it("最後の試行の後は待たない（＝やり直さない）", () => {
    assert.equal(retryDelayMs(MAX_ATTEMPTS), null);
    assert.equal(retryDelayMs(MAX_ATTEMPTS + 1), null);
  });

  it("試行の合間だけ待ち時間を返し、回を追うごとに延びる", () => {
    const first = retryDelayMs(1);
    const second = retryDelayMs(2);
    assert.ok(first !== null && first > 0);
    assert.ok(second !== null && second > first);
  });

  it("待ち時間の合計を1分以内に収める", () => {
    // systemd の oneshot ジョブが居座らないようにするため。
    // 次の実行（30分後）にも余裕があるので、ここで粘りきる必要はない。
    let total = 0;
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) total += retryDelayMs(attempt) ?? 0;
    assert.ok(total <= 60_000, `合計 ${total}ms は長すぎます`);
  });

  it("0以下の試行回数では待たない", () => {
    assert.equal(retryDelayMs(0), null);
  });
});

describe("readZaimCredentials", () => {
  it("両方揃っているときだけ返す", () => {
    assert.deepEqual(readZaimCredentials({ ZAIM_EMAIL: "a@example.test", ZAIM_PASSWORD: "x" }), {
      email: "a@example.test",
      password: "x",
    });
  });

  it("片方だけの設定漏れは未設定として扱う", () => {
    // 中途半端に試すと、失敗の理由が「設定漏れ」ではなく「ログイン失敗」に見えてしまう。
    assert.equal(readZaimCredentials({ ZAIM_EMAIL: "a@example.test" }), null);
    assert.equal(readZaimCredentials({ ZAIM_PASSWORD: "x" }), null);
  });

  it("空文字・空白だけの値は未設定として扱う", () => {
    // .env のテンプレートは `ZAIM_EMAIL=` の形で配るため、空が既定の状態になる。
    assert.equal(readZaimCredentials({ ZAIM_EMAIL: "", ZAIM_PASSWORD: "" }), null);
    assert.equal(readZaimCredentials({ ZAIM_EMAIL: "  ", ZAIM_PASSWORD: "x" }), null);
  });

  it("何も設定されていなければ null", () => {
    assert.equal(readZaimCredentials({}), null);
  });
});
