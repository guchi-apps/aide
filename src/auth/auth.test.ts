import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { loadAuthConfig, resolveBaseUrl, verifyPassword } from "./config.ts";
import { verifyPkce } from "./oauth.ts";

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
