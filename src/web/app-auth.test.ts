import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import {
  APP_CALLBACK_URL,
  appCallbackUrl,
  consumeAppHandoff,
  isAppChallenge,
  issueAppHandoff,
  resetAppHandoffs,
} from "./app-auth.ts";

const VERIFIER = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~".slice(0, 64);
const CHALLENGE = createHash("sha256").update(VERIFIER, "ascii").digest("base64url");

afterEach(() => resetAppHandoffs());

describe("iOSアプリへのログイン引き継ぎ", () => {
  it("正しいverifierなら一度だけ交換できる", () => {
    const code = issueAppHandoff(
      { email: "me@example.com", next: "/map", challenge: CHALLENGE },
      1_000,
    );

    assert.deepEqual(consumeAppHandoff(code, VERIFIER, "web", 2_000), {
      email: "me@example.com",
      next: "/map",
    });
    assert.equal(consumeAppHandoff(code, VERIFIER, "web", 2_000), null);
  });

  it("違うverifierでは交換できず、そのコードは再利用できない", () => {
    const code = issueAppHandoff(
      { email: "me@example.com", next: "/features", challenge: CHALLENGE },
      1_000,
    );

    const wrong = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~".slice(0, 64);
    assert.equal(consumeAppHandoff(code, wrong, "web", 2_000), null);
    assert.equal(consumeAppHandoff(code, VERIFIER, "web", 2_000), null);
  });

  it("用途が違うコードは交換できない（Web用でモバイルのトークンは取れない）", () => {
    const web = issueAppHandoff({ email: "me@example.com", next: "/map", challenge: CHALLENGE }, 1_000);
    assert.equal(consumeAppHandoff(web, VERIFIER, "mobile", 2_000), null);

    const mobile = issueAppHandoff(
      { email: "me@example.com", next: "/map", challenge: CHALLENGE, purpose: "mobile" },
      1_000,
    );
    assert.equal(consumeAppHandoff(mobile, VERIFIER, "web", 2_000), null);

    const again = issueAppHandoff(
      { email: "me@example.com", next: "/map", challenge: CHALLENGE, purpose: "mobile" },
      1_000,
    );
    assert.equal(consumeAppHandoff(again, VERIFIER, "mobile", 2_000)?.email, "me@example.com");
  });

  it("2分を過ぎたコードは交換できない", () => {
    const code = issueAppHandoff(
      { email: "me@example.com", next: "/map", challenge: CHALLENGE },
      1_000,
    );
    assert.equal(consumeAppHandoff(code, VERIFIER, "web", 121_001), null);
  });

  it("S256のchallenge以外は受け付けない", () => {
    assert.equal(isAppChallenge(CHALLENGE), true);
    assert.equal(isAppChallenge("short"), false);
    assert.throws(
      () => issueAppHandoff({ email: "me@example.com", next: "/map", challenge: "short" }),
      /invalid app PKCE challenge/,
    );
  });

  it("固定のカスタムURLスキームへ不透明なコードだけを返す", () => {
    const callback = appCallbackUrl({ code: "opaque-code" });
    assert.equal(new URL(callback).protocol, "com.gucchii.aide:");
    assert.equal(new URL(callback).pathname, "/auth/callback");
    assert.equal(new URL(callback).searchParams.get("code"), "opaque-code");
    assert.ok(APP_CALLBACK_URL.startsWith("com.gucchii.aide:"));
  });
});
