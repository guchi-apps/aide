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

  it("転送ヘッダから送信元を取り出す", () => {
    const req = {
      headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" },
      socket: { remoteAddress: "10.0.0.1" },
    } as unknown as Parameters<typeof clientKey>[0];
    // プロキシ配下では socket のアドレスが全リクエストで同一になり、
    // 送信元ごとの制限が機能しなくなる。
    assert.equal(clientKey(req), "203.0.113.9");
  });
});
