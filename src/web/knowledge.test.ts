import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildKnowledgeView, emptyKnowledgeView } from "../core/views/knowledge.ts";
import type { GitHubKnowledgeRaw } from "../core/connectors/github/knowledge.ts";
import { CANDIDATE_MARKER, JUDGED_MARKER } from "../core/views/knowledge.ts";
import { renderKnowledgePage } from "./knowledge.ts";

/**
 * 描画は純粋関数（`renderKnowledgePage`）なので、テストはここへ当てる。
 *
 * 見た目そのものではなく、**外へ出してはいけないものが出ていないか**と、
 * 判断の分かれ目（未設定・取得失敗・判定の滞留）で文言が切り替わるかを見る。
 */

const NOW = new Date("2026-08-25T00:00:00.000Z");

function raw(overrides: Partial<GitHubKnowledgeRaw> = {}): GitHubKnowledgeRaw {
  return {
    repoUrl: "https://github.com/guchi-apps/docs",
    branch: "main",
    directories: [
      {
        path: "knowledge",
        files: [
          {
            path: "knowledge/github-actions.md",
            text: [
              "# GitHub Actions の共通知見",
              "",
              "## 既定の`GITHUB_TOKEN`では`.github/workflows/`配下へpushできない",
              "",
              "- **確認日**: 2026-08-09",
              "- **出典リポジトリ**: guchi-apps/issue-deck#106",
            ].join("\n"),
            truncated: false,
          },
        ],
      },
      { path: "standards", files: [{ path: "standards/ports.md", text: "# ポート\n\n## 割り当て\n", truncated: false }] },
    ],
    issues: [
      {
        repo: "guchi-apps/issue-deck",
        number: 2286,
        title: "ログイン通知のWebhook URLを追加する",
        url: "https://github.com/guchi-apps/issue-deck/issues/2286",
        state: "CLOSED",
        comments: [
          {
            body: `${CANDIDATE_MARKER}\n### organization secretは同名のrepository secretにだけ覆われる\n\n- 確認日: 2026-08-25\n`,
            createdAt: "2026-08-20T00:00:00Z",
            url: "",
          },
        ],
      },
    ],
    issueCount: 1,
    truncated: false,
    rateLimit: { remaining: 4900, resetAt: "2026-08-25T01:00:00Z" },
    failures: [],
    ...overrides,
  };
}

describe("renderKnowledgePage", () => {
  it("共有知識の見出しと、知見メモの一覧を載せる", () => {
    const html = renderKnowledgePage(buildKnowledgeView(raw(), NOW), { email: "someone@example.com" });

    assert.match(html, /共通知識と、その採用・却下の記録/);
    assert.match(html, /knowledge\/github-actions\.md/);
    assert.match(html, /確認 2026-08-09/);
    assert.match(html, /organization secretは同名のrepository secretにだけ覆われる/);
    assert.match(html, /issue-deck#2286/);
    // ナビは3つになり、共通知識が現在地になる。
    assert.match(html, /href="\/knowledge" class="on"/);
  });

  it("Markdownの記法をそのまま見せず、コードと太字だけを組み立て直す", () => {
    const html = renderKnowledgePage(buildKnowledgeView(raw(), NOW));

    // 見出しに含まれる `GITHUB_TOKEN` は等幅で出す。backtick は残さない。
    assert.match(html, /<span class="mono">GITHUB_TOKEN<\/span>/);
    assert.doesNotMatch(html, /`GITHUB_TOKEN`/);
  });

  it("判定が1件も無いときは、判定側が止まっている可能性を先頭に出す", () => {
    const html = renderKnowledgePage(buildKnowledgeView(raw(), NOW));

    assert.match(html, /格上げ判定の記録が1件もありません/);
    assert.match(html, /promote-knowledge\.yml/);
    assert.match(html, /class="pill danger"/);
  });

  it("採用と却下が付いていれば、反映先と理由を出す", () => {
    const judged = raw({
      issues: [
        {
          repo: "guchi-apps/issue-deck",
          number: 106,
          title: "ワークフローを更新する",
          url: "https://github.com/guchi-apps/issue-deck/issues/106",
          state: "CLOSED",
          comments: [
            { body: `${CANDIDATE_MARKER}\n### 知見A\n`, createdAt: "2026-08-20T00:00:00Z", url: "" },
            {
              body: `- ✅ 承認: 知見A → \`knowledge/github-actions.md\`（既存セクションの更新）\n  - 理由: 全アプリに当てはまる\n${JUDGED_MARKER}`,
              createdAt: "2026-08-23T00:00:00Z",
              url: "",
            },
          ],
        },
      ],
    });
    const html = renderKnowledgePage(buildKnowledgeView(judged, NOW));

    assert.match(html, /採用/);
    assert.match(html, /全アプリに当てはまる/);
    assert.doesNotMatch(html, /格上げ判定の記録が1件もありません/);
  });

  it("トークン未設定なら、GitHubを見ていないことを明示する", () => {
    const html = renderKnowledgePage(emptyKnowledgeView(NOW));

    assert.match(html, /AIDE_GITHUB_TOKEN が未設定/);
    assert.match(html, /class="pill muted"/);
    // 空の一覧で「判定が止まっている」と誤解させない。
    assert.doesNotMatch(html, /格上げ判定の記録が1件もありません/);
  });

  it("取得に失敗したことを握りつぶさず、理由まで出す", () => {
    const html = renderKnowledgePage(
      buildKnowledgeView(raw({ failures: [{ source: "guchi-apps/docs", reason: "HTTP 403（権限不足かレート制限）" }] }), NOW),
    );

    assert.match(html, /HTTP 403（権限不足かレート制限）/);
    assert.match(html, /AIDE_GITHUB_TOKEN に guchi-apps 配下の読み取り権限/);
  });

  it("読める範囲までしか取れていないことを伏せない", () => {
    const html = renderKnowledgePage(buildKnowledgeView(raw({ truncated: true }), NOW));
    assert.match(html, /新しいものから順に読める範囲まで/);
  });
});
