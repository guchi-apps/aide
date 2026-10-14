import {
  callReviewAgentTool,
  readReviewAgentConfig,
  type ReviewAgentToolName,
} from "../../core/connectors/issue-deck/review-agent.ts";
import type { Tool, ToolResult } from "../types.ts";

function result(payload: unknown, isError = false): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

const repository = { type: "string", description: "owner/name。トークンの許可リストに無ければ拒否される。" };
const issue = { type: "integer", description: "修正Issue番号" };
const epoch = { type: "integer", description: "get_fix_status の assignee.epoch（現在の担当の世代）" };
const agent = { type: "string", description: "このエージェントの識別名（英数字・._-、60文字以内）" };
const idempotencyKey = {
  type: "string",
  description: "**呼び出し側が操作ごとに新しく作る**重複防止キー（8〜120文字）。同じ操作の再送は同じ値、別の操作は別の値にする。",
};
const sha = { type: "string", description: "実際に検証した40桁のコミットSHA。ブランチのHEADと違えば stale_sha で拒否される。" };
const write = { repository, issue, agent, idempotencyKey };
const WRITE_REQUIRED = ["repository", "issue", "agent", "idempotencyKey"];

/**
 * issue-deck の `callReviewAgentTool` と同じ名前・同じ引数で中継する薄いツール。引数の検証・認可・
 * 状態遷移は issue-deck 側が行うので、ここでは必須項目の宣言だけを持つ（`inputSchema` は案内用）。
 */
function relay(
  remote: ReviewAgentToolName,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): Tool {
  return {
    name: `issue_deck_${remote}`,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    handler: async (args) => {
      const config = readReviewAgentConfig();
      if (!config) {
        return result({
          status: "not_configured",
          reason: "issue-deckの全体レビュー・修正APIが未設定です（AIDE_ISSUE_DECK_URL と AIDE_ISSUE_DECK_REVIEW_AGENT_TOKEN が要ります）。",
        });
      }
      const outcome = await callReviewAgentTool(config, remote, args);
      if (!outcome.ok) {
        return result({ status: "error", reason: outcome.reason, httpStatus: outcome.httpStatus, response: outcome.body }, true);
      }
      return result(outcome.body);
    },
  };
}

const READ_NOTE = "読み取り専用（issue-deckは何も書かず、GitHubも呼ばない）。";
const WRITE_NOTE = "**書き込みを伴うツール。** 明示的に頼まれた操作でだけ呼ぶ。本番マージ・公開の承認の代わりにはならない。";

export const issueDeckReviewAgentTools: Tool[] = [
  relay(
    "list_release_candidates",
    `issue-deckのリリース候補を新しい順に一覧する（現行revisionのPR・base/head付き）。${READ_NOTE}` +
      "続きは前回応答の page.nextCursor を cursor に渡す。",
    { repository, limit: { type: "integer", minimum: 1, maximum: 50 }, cursor: { type: "integer", description: "前の応答の page.nextCursor" } },
    ["repository"],
  ),
  relay(
    "get_release_candidate",
    `リリース候補1件の全体レビュー（指摘・重要度・根拠・推奨対応）・統合検証・履歴・関連修正Issue/PRを返す。${READ_NOTE}` +
      "relation が stale_sha の結果は現在の合否に使わない。指摘は findingsOffset / findingsLimit でページングし、truncated を見落とさない。",
    {
      repository,
      sequence: { type: "integer", description: "候補番号" },
      findingsOffset: { type: "integer", minimum: 0 },
      findingsLimit: { type: "integer", minimum: 1, maximum: 50 },
    },
    ["repository", "sequence"],
  ),
  relay(
    "get_fix_status",
    `修正Issue1件の指摘（F-001…）・往復・テスト・担当と世代epoch・一時停止の理由と次の操作を返す。報告の前に必ず読む。${READ_NOTE}`,
    { repository, issue },
    ["repository", "issue"],
  ),
  relay(
    "claim_fix",
    `修正Issueの担当を取得する。応答の epoch を以降の報告へ添える。別の担当が持ち時間内なら takeover: true で引き継ぐ。${WRITE_NOTE}`,
    { ...write, takeover: { type: "boolean" } },
    WRITE_REQUIRED,
  ),
  relay(
    "release_fix",
    `修正Issueの担当を解放する（記録は残る）。${WRITE_NOTE}`,
    { ...write, epoch },
    [...WRITE_REQUIRED, "epoch"],
  ),
  relay(
    "pause_fix",
    `修正を一時停止する。kind は environment（実行環境の障害）か needs_decision（人の判断・権限の不足）。${WRITE_NOTE}`,
    { ...write, epoch, kind: { type: "string", enum: ["environment", "needs_decision"] }, detail: { type: "string" } },
    [...WRITE_REQUIRED, "epoch", "kind"],
  ),
  relay(
    "resume_fix",
    `回復済みの environment 停止だけを入力なしで再開する。予算の追加・方針が要る停止は画面から人が再開する。${WRITE_NOTE}`,
    write,
    WRITE_REQUIRED,
  ),
  relay(
    "report_fix_test",
    `修正の必要テストの結果を報告する。実際にテストした sha が必須（HEADと違えば拒否し、付け替えない）。${WRITE_NOTE}`,
    {
      ...write,
      epoch,
      sha,
      state: { type: "string", enum: ["passed", "failed"] },
      summary: { type: "string" },
    },
    [...WRITE_REQUIRED, "epoch", "sha", "state"],
  ),
  relay(
    "report_fix_review",
    "修正の独立レビュー結果を報告する。実際にレビューした sha が必須。解消した指摘は resolved[].resolution に根拠が要る。" +
      `実装担当と同じトークンは独立レビューにならず、self_review_not_independent で拒否される。${WRITE_NOTE}`,
    {
      ...write,
      epoch,
      sha,
      verdict: { type: "string", enum: ["pass", "findings"] },
      newFindings: {
        type: "array",
        items: { type: "object", properties: { title: { type: "string" }, detail: { type: "string" } }, required: ["title"] },
      },
      stillOpen: { type: "array", items: { type: "string" }, description: "未解消の指摘キー（F-001など）" },
      resolved: {
        type: "array",
        items: { type: "object", properties: { key: { type: "string" }, resolution: { type: "string" } }, required: ["key", "resolution"] },
      },
    },
    [...WRITE_REQUIRED, "epoch", "sha", "verdict"],
  ),
];
