import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { acquireZaimWebScreenLock, releaseZaimWebScreenLock } from "./web-screen-lock.ts";

describe("acquireZaimWebScreenLock / releaseZaimWebScreenLock", () => {
  it("最初の取得は true、解放するまで次は false", () => {
    assert.equal(acquireZaimWebScreenLock(), true);
    assert.equal(acquireZaimWebScreenLock(), false, "画面を操作中なら待たせずに断る");
    releaseZaimWebScreenLock();
    assert.equal(acquireZaimWebScreenLock(), true, "解放後は取得できる");
    releaseZaimWebScreenLock();
  });
});
