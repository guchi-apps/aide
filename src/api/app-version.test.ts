import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAppVersion } from "./app-version.ts";
import { readPackageVersion } from "../core/version.ts";

describe("buildAppVersion", () => {
  it("APP_COMMIT_SHA をそのまま sha に入れる", () => {
    assert.deepEqual(buildAppVersion({ APP_COMMIT_SHA: "abc123" }, "1.2.3"), { version: "1.2.3", sha: "abc123" });
  });

  it("未設定・空なら null（推測値を返さない）", () => {
    assert.equal(buildAppVersion({}, "1.2.3").sha, null);
    assert.equal(buildAppVersion({ APP_COMMIT_SHA: "" }, "1.2.3").sha, null);
    assert.equal(buildAppVersion({ APP_COMMIT_SHA: "  " }, "1.2.3").sha, null);
  });

  it("版は既定で package.json の version", () => {
    assert.equal(buildAppVersion({}).version, readPackageVersion());
  });

  it("稼働版の照合が読む sha が \"sha\":\"<SHA>\" の形でJSON化される", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    assert.ok(JSON.stringify(buildAppVersion({ APP_COMMIT_SHA: sha }, "1.0.0")).includes(`"sha":"${sha}"`));
  });
});
