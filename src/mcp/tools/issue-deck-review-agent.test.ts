import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { REVIEW_AGENT_TOOLS } from "../../core/connectors/issue-deck/review-agent.ts";
import type { ToolResult } from "../types.ts";
import { issueDeckReviewAgentTools } from "./issue-deck-review-agent.ts";

const TOKEN = "ida_test-token";

function parsed(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}
function tool(name: string) {
  const found = issueDeckReviewAgentTools.find((t) => t.name === name);
  assert.ok(found, name);
  return found;
}
const call = (name: string, args: Record<string, unknown>) => tool(name).handler(args, { sessionId: null });

describe("issue_deck_* 全体レビュー・修正API", () => {
  beforeEach(() => {
    process.env["AIDE_ISSUE_DECK_URL"] = "https://deck.example.test/";
    process.env["AIDE_ISSUE_DECK_REVIEW_AGENT_TOKEN"] = TOKEN;
  });
  afterEach(() => {
    mock.restoreAll();
    delete process.env["AIDE_ISSUE_DECK_URL"];
    delete process.env["AIDE_ISSUE_DECK_REVIEW_AGENT_TOKEN"];
  });

  it("issue-deckの9ツールすべてを、同名で1対1に公開する", () => {
    assert.deepEqual(
      issueDeckReviewAgentTools.map((t) => t.name),
      REVIEW_AGENT_TOOLS.map((name) => `issue_deck_${name}`),
    );
  });

  it("更新系は idempotencyKey と agent を必須として宣言する", () => {
    for (const name of ["claim_fix", "release_fix", "pause_fix", "resume_fix", "report_fix_test", "report_fix_review"]) {
      const required = tool(`issue_deck_${name}`).inputSchema["required"] as string[];
      assert.ok(required.includes("idempotencyKey") && required.includes("agent"), name);
    }
  });

  it("未設定なら送信せず not_configured を返す", async () => {
    delete process.env["AIDE_ISSUE_DECK_REVIEW_AGENT_TOKEN"];
    const fetchMock = mock.method(globalThis, "fetch", async () => new Response("{}"));
    assert.equal(parsed(await call("issue_deck_get_fix_status", { repository: "a/b", issue: 1 }))["status"], "not_configured");
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  it("専用トークンのBearerで、引数をそのまま中継して応答を返す", async () => {
    const args = { repository: "a/b", issue: 5, agent: "x", idempotencyKey: "key-12345678" };
    const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
      assert.equal(input, "https://deck.example.test/api/review-agent/tools/claim_fix");
      assert.equal(init?.method, "POST");
      assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
      assert.deepEqual(JSON.parse(init?.body as string), args);
      return Response.json({ epoch: 3 });
    });
    const result = await call("issue_deck_claim_fix", args);
    assert.equal(fetchMock.mock.callCount(), 1);
    assert.equal(result.isError, false);
    assert.deepEqual(parsed(result), { epoch: 3 });
  });

  it("拒否の応答は isError にし、error・refetchRequired を落とさず返す。トークンは出さない", async () => {
    mock.method(globalThis, "fetch", async () =>
      Response.json({ error: "stale_sha", message: "古い", refetchRequired: true, details: { currentSha: "a".repeat(40) } }, { status: 409 }),
    );
    const result = await call("issue_deck_report_fix_test", { repository: "a/b", issue: 1 });
    assert.equal(result.isError, true);
    const body = parsed(result);
    assert.equal(body["httpStatus"], 409);
    assert.equal((body["response"] as Record<string, unknown>)["error"], "stale_sha");
    assert.ok(!result.content[0]!.text.includes(TOKEN));
  });

  it("届かなかった場合は例外のmessage（URL）を出さずに isError を返す", async () => {
    mock.method(globalThis, "fetch", async () => {
      throw new Error("connect ECONNREFUSED https://deck.example.test/");
    });
    const result = await call("issue_deck_list_release_candidates", { repository: "a/b" });
    assert.equal(result.isError, true);
    assert.ok(!result.content[0]!.text.includes("deck.example.test"));
  });
});
