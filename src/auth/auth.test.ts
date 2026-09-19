import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { loadAuthConfig, resolveBaseUrl, verifyPassword } from "./config.ts";
import { verifyPkce } from "./oauth.ts";
import {
  allowRegistration,
  clientKey,
  lockedFor,
  recordFailure,
  recordSuccess,
  resetRateLimits,
  trackedKeyCount,
} from "./ratelimit.ts";

describe("パスワード照合", () => {
  it("一致する場合のみ true", () => {
    assert.equal(verifyPassword("correct-horse", "correct-horse"), true);
    assert.equal(verifyPassword("wrong", "correct-horse"), false);
  });

  it("長さが違っても例外を投げずに false を返す", () => {
    assert.equal(verifyPassword("", "correct-horse"), false);
    assert.equal(verifyPassword("correct-horse-longer", "correct-horse"), false);
  });
});

describe("PKCE", () => {
  it("正しい verifier を受け入れる", () => {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    assert.equal(verifyPkce(verifier, challenge), true);
  });

  it("異なる verifier を拒否する", () => {
    const challenge = createHash("sha256").update("a").digest("base64url");
    assert.equal(verifyPkce("b", challenge), false);
  });
});

describe("設定", () => {
  it("パスワード未設定かつ明示的な無効化が無ければ起動を拒否する", () => {
    // 認証なしのまま公開してしまう事故を、起動失敗として顕在化させるため。
    const saved = { ...process.env };
    delete process.env["AIDE_AUTH_PASSWORD"];
    delete process.env["AIDE_AUTH_DISABLED"];
    assert.throws(() => loadAuthConfig(), /AIDE_AUTH_PASSWORD/);
    process.env = saved;
  });
});

describe("公開URLの解決", () => {
  it("リバースプロキシのヘッダを優先する", () => {
    const saved = process.env["AIDE_BASE_URL"];
    delete process.env["AIDE_BASE_URL"];
    assert.equal(
      resolveBaseUrl({ host: "127.0.0.1:4747", "x-forwarded-host": "aide.example.com", "x-forwarded-proto": "https" }),
      "https://aide.example.com",
    );
    if (saved) process.env["AIDE_BASE_URL"] = saved;
  });
});

describe("総当たり対策", () => {
  it("既定では制限にかからない", () => {
    resetRateLimits();
    assert.equal(lockedFor("1.2.3.4"), null);
  });

  it("既定回数の失敗でロックされる", () => {
    resetRateLimits();
    for (let i = 0; i < 5; i += 1) recordFailure("1.2.3.4");
    const locked = lockedFor("1.2.3.4");
    assert.ok(locked !== null && locked > 0, "ロックされるべき");
  });

  it("ロックは送信元ごとに独立している", () => {
    resetRateLimits();
    for (let i = 0; i < 5; i += 1) recordFailure("1.2.3.4");
    assert.equal(lockedFor("5.6.7.8"), null);
  });

  it("成功すると失敗回数がリセットされる", () => {
    resetRateLimits();
    for (let i = 0; i < 4; i += 1) recordFailure("1.2.3.4");
    recordSuccess("1.2.3.4");
    // リセット後は、あと1回の失敗ではロックされない
    recordFailure("1.2.3.4");
    assert.equal(lockedFor("1.2.3.4"), null);
  });

  it("クライアント登録は上限を超えると拒否される", () => {
    resetRateLimits();
    for (let i = 0; i < 20; i += 1) {
      assert.equal(allowRegistration("1.2.3.4"), true, `${i + 1}回目は許可されるべき`);
    }
    assert.equal(allowRegistration("1.2.3.4"), false, "21回目は拒否されるべき");
  });

  it("転送ヘッダの末尾（手前のプロキシが足した値）を送信元にする", () => {
    // プロキシ配下では socket のアドレスが全リクエストで同一になり、
    // 送信元ごとの制限が機能しなくなるため、転送ヘッダを使う。
    // 先頭はクライアントが自由に書けるので、プロキシが末尾に足した値を採る（#300）。
    assert.equal(clientKey(fakeRequest("203.0.113.9, 198.51.100.7", "127.0.0.1")), "198.51.100.7");
    assert.equal(clientKey(fakeRequest("198.51.100.7", "::1")), "198.51.100.7");
    assert.equal(clientKey(fakeRequest(["203.0.113.9", "198.51.100.7"], "::ffff:127.0.0.1")), "198.51.100.7");
  });

  it("先頭を偽装しても別の送信元として数えられず、ロックされる", () => {
    resetRateLimits();
    for (let i = 0; i < 5; i += 1) {
      recordFailure(clientKey(fakeRequest(`10.0.0.${i}, 198.51.100.7`, "127.0.0.1")));
    }
    const locked = lockedFor(clientKey(fakeRequest("192.0.2.1, 198.51.100.7", "127.0.0.1")));
    assert.ok(locked !== null && locked > 0, "偽装した値によらずロックされるべき");
  });

  it("プロキシを通らない接続では転送ヘッダを信用しない", () => {
    assert.equal(clientKey(fakeRequest("203.0.113.9", "100.64.0.5")), "100.64.0.5");
  });

  it("転送ヘッダが無ければ socket のアドレスを使う", () => {
    assert.equal(clientKey(fakeRequest(undefined, "127.0.0.1")), "127.0.0.1");
  });

  it("失敗の記録は上限を超えて増えない", () => {
    resetRateLimits();
    for (let i = 0; i < 10_500; i += 1) recordFailure(`key-${i}`);
    assert.equal(trackedKeyCount().failures, 10_000);
    // 記録済みの送信元への失敗は件数を増やさない
    recordFailure("key-10499");
    assert.equal(trackedKeyCount().failures, 10_000);
    resetRateLimits();
  });

  it("クライアント登録の記録は上限を超えて増えない", () => {
    resetRateLimits();
    for (let i = 0; i < 10_500; i += 1) allowRegistration(`key-${i}`);
    assert.equal(trackedKeyCount().registrations, 10_000);
    resetRateLimits();
  });
});

function fakeRequest(forwarded: string | string[] | undefined, remoteAddress: string) {
  return {
    headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded },
    socket: { remoteAddress },
  } as unknown as Parameters<typeof clientKey>[0];
}
