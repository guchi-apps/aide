import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { DEFAULT_LABELS } from "../../core/connectors/github/write.ts";
import { createIssueTool } from "./issue.ts";
import type { ToolResult } from "../types.ts";

/**
 * **起票は取り消せない**（この経路に編集・closeは無い）。ネットワークへ出る手前
 * （未設定・dryRun）までしか踏まない。テストからGitHubは叩かない。
 */

const CTX = { sessionId: null };

function parse(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe("aide_create_issue の宣言", () => {
  it("明示的に頼まれたときだけ呼ぶ旨を説明文に書いている", () => {
    assert.match(createIssueTool.description, /明示的に頼まれたときだけ/);
  });

  it("dryRun を持つことを説明文に書いている", () => {
    assert.match(createIssueTool.description, /dryRun/);
  });

  it("repo・title が必須で、知らない引数は受け付けない", () => {
    assert.deepEqual(createIssueTool.inputSchema["required"], ["repo", "title"]);
    assert.equal(createIssueTool.inputSchema["additionalProperties"], false);
  });
});

describe("aide_create_issue ハンドラ", () => {
  beforeEach(() => {
    delete process.env["AIDE_GITHUB_ISSUE_TOKEN"];
  });

  it("トークンが無ければ未設定として返し、GitHubへは送らない", async () => {
    const result = await createIssueTool.handler({ repo: "aide", title: "下見" }, CTX);
    assert.equal(parse(result)["ok"], false);
    assert.match(String(parse(result)["reason"]), /未設定/);
    assert.equal(result.isError, false);
  });

  it("dryRun では起票せず、何が起票されるかだけを返す", async () => {
    // トークンを置いてもネットワークへ出ないことが要点。出ていれば認証エラーで返る。
    process.env["AIDE_GITHUB_ISSUE_TOKEN"] = "dummy";
    const payload = parse(
      await createIssueTool.handler(
        { repo: "aide", title: "下見", body: "本文", labels: ["51.improvement"], dryRun: true },
        CTX,
      ),
    );

    assert.equal(payload["ok"], true);
    assert.equal(payload["dryRun"], true);
    assert.deepEqual(payload["wouldCreate"], {
      repo: "aide",
      title: "下見",
      body: "本文",
      labels: ["51.improvement"],
    });
    assert.equal(payload["number"], undefined);
  });

  it("dryRun で labels を省けば既定のラベルを示す", async () => {
    process.env["AIDE_GITHUB_ISSUE_TOKEN"] = "dummy";
    const payload = parse(await createIssueTool.handler({ repo: "aide", title: "下見", dryRun: true }, CTX));
    assert.deepEqual((payload["wouldCreate"] as Record<string, unknown>)["labels"], DEFAULT_LABELS);
  });

  it("dryRun はラベルの実在までは確かめないと断る", async () => {
    // 確かめたつもりにさせると、起票時に黙って落ちたラベルに気づけない。
    process.env["AIDE_GITHUB_ISSUE_TOKEN"] = "dummy";
    const payload = parse(await createIssueTool.handler({ repo: "aide", title: "下見", dryRun: true }, CTX));
    assert.match(String(payload["note"]), /実在するかは確かめていません/);
  });
});
