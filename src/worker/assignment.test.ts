import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAssigned, parseAssignment } from "./assignment.ts";

describe("parseAssignment", () => {
  it("未設定・空・all・* は全ジョブを担当する", () => {
    for (const raw of [undefined, "", "  ", "all", "*"]) {
      assert.equal(isAssigned(parseAssignment(raw), "zaim-sync"), true);
    }
  });

  it("列挙したジョブだけ担当する（空白は許す）", () => {
    const a = parseAssignment("zaim-sync, zaim-refresh");
    assert.equal(isAssigned(a, "zaim-sync"), true);
    assert.equal(isAssigned(a, "zaim-refresh"), true);
    assert.equal(isAssigned(a, "weather-sync"), false);
  });

  it("none は何も担当しない", () => {
    assert.equal(isAssigned(parseAssignment("none"), "weather-sync"), false);
  });

  it("未知のジョブ名は例外にする", () => {
    assert.throws(() => parseAssignment("zaim-sync,zaim-snyc"), /zaim-snyc/);
  });
});

describe("self-update は AIDE_WORKER_JOBS に左右されない（#897）", () => {
  it("none・一部のジョブだけの絞り込みでも担当に含める", () => {
    for (const raw of ["none", "zaim-refresh,zaim-sync,zaim-money-sync,zaim-keep-alive", undefined]) {
      assert.equal(isAssigned(parseAssignment(raw), "self-update"), true, String(raw));
    }
    assert.equal(isAssigned(parseAssignment("zaim-sync"), "weather-sync"), false);
  });
});
