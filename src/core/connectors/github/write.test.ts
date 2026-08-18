import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildBody, CreationGuard, FOOTNOTE, normalizeRepo, selectExistingLabels } from "./write.ts";

/**
 * 起票そのもの（`createIssue`）はGitHubへのHTTPが本体なのでここでは扱わない。
 * テストを集めるのは、**間違えると実際に副作用が出る**純粋な部分に限る。
 *
 * - ラベルの照合（間違えると、対象リポジトリに無いラベルを勝手に作ってしまう）
 * - 暴発ガード（間違えると、Issueが量産される）
 * - 本文の脚注（無いと、口述由来のIssueを後から見分けられない）
 */

describe("normalizeRepo", () => {
  it("リポジトリ名だけならそのまま通す", () => {
    assert.deepEqual(normalizeRepo("issue-deck"), { repo: "issue-deck" });
    assert.deepEqual(normalizeRepo("  aide  "), { repo: "aide" });
  });

  it("owner 付きは、リポジトリ名だけを渡すよう促して断る", () => {
    const result = normalizeRepo("guchi-apps/aide");
    assert.ok("error" in result);
    // 何を渡せばよいかが分かるよう、名前の部分を文言に含める。
    assert.match(result.error, /aide/);
  });

  it("空とリポジトリ名に使えない文字は断る", () => {
    assert.ok("error" in normalizeRepo("   "));
    assert.ok("error" in normalizeRepo("aide?x=1"));
    assert.ok("error" in normalizeRepo("../../etc"));
  });
});

describe("selectExistingLabels", () => {
  it("実在するものだけを付け、残りは落とす", () => {
    const { applied, dropped } = selectExistingLabels(
      ["70.confirm", "50.feature"],
      ["00.check-user", "70.confirm"],
    );
    assert.deepEqual(applied, ["70.confirm"]);
    assert.deepEqual(dropped, ["50.feature"]);
  });

  it("大文字小文字は区別せず、リポジトリ側の表記に合わせる", () => {
    const { applied, dropped } = selectExistingLabels(["BUG"], ["bug"]);
    assert.deepEqual(applied, ["bug"]);
    assert.deepEqual(dropped, []);
  });

  it("重複と空白だけの指定は無視する", () => {
    const { applied } = selectExistingLabels(["70.confirm", " 70.confirm ", "  "], ["70.confirm"]);
    assert.deepEqual(applied, ["70.confirm"]);
  });

  it("ラベル一覧が引けなかった場合（空）は1つも付けない", () => {
    // ここで素通しすると、GitHubがラベルを勝手に新規作成してしまう。
    const { applied, dropped } = selectExistingLabels(["70.confirm"], []);
    assert.deepEqual(applied, []);
    assert.deepEqual(dropped, ["70.confirm"]);
  });
});

describe("buildBody", () => {
  it("本文の末尾に出所の脚注を付ける", () => {
    const body = buildBody("外出先で思いついたこと。");
    assert.match(body, /^外出先で思いついたこと。/);
    assert.ok(body.endsWith(FOOTNOTE));
  });

  it("本文が空でも脚注だけは残す", () => {
    assert.equal(buildBody(undefined), FOOTNOTE);
    assert.equal(buildBody("   "), FOOTNOTE);
  });
});

describe("CreationGuard", () => {
  it("上限まで通し、超えたら理由を返す", () => {
    const guard = new CreationGuard(10 * 60 * 1000, 3);
    assert.equal(guard.admit("aide 1件目", 0), null);
    assert.equal(guard.admit("aide 2件目", 1_000), null);
    assert.equal(guard.admit("aide 3件目", 2_000), null);

    const rejected = guard.admit("aide 4件目", 3_000);
    assert.ok(rejected);
    assert.match(rejected, /10分あたり3件/);
  });

  it("窓を過ぎたぶんは数えない", () => {
    const guard = new CreationGuard(10 * 60 * 1000, 3);
    guard.admit("a", 0);
    guard.admit("b", 1_000);
    guard.admit("c", 2_000);
    assert.equal(guard.admit("d", 10 * 60 * 1000), null);
  });

  it("直前とまったく同じリポジトリ・タイトルは重複とみなして断る", () => {
    const guard = new CreationGuard(10 * 60 * 1000, 3);
    assert.equal(guard.admit("aide 同じ話", 0), null);

    const rejected = guard.admit("aide 同じ話", 1_000);
    assert.ok(rejected);
    assert.match(rejected, /重複/);
  });

  it("断ったぶんは上限に数えない", () => {
    // 断った回数まで数えると、重複を1回弾いただけで残り枠が減ってしまう。
    const guard = new CreationGuard(10 * 60 * 1000, 3);
    guard.admit("aide 同じ話", 0);
    guard.admit("aide 同じ話", 1_000);
    assert.equal(guard.admit("aide 別の話", 2_000), null);
    assert.equal(guard.admit("aide さらに別の話", 3_000), null);
    assert.ok(guard.admit("aide 4件目", 4_000));
  });
});
