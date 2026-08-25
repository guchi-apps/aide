import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildKnowledgeView,
  CANDIDATE_MARKER,
  emptyKnowledgeView,
  JUDGED_MARKER,
  parseKnowledgeFile,
  parseMemoComment,
  parseVerdictComment,
} from "./knowledge.ts";
import type { GitHubKnowledgeRaw, KnowledgeIssueNode } from "../connectors/github/knowledge.ts";

/**
 * 解析と突き合わせは純粋関数なので、テストはここへ集中させる。
 * GraphQLのクエリ側はGitHubの実物が契約なので、ここでは触らない。
 *
 * **本文は実際にguchi-apps配下へ投稿されているものの形をなぞってある。**
 * 知見メモの書式は揃っておらず（`###` の見出し・`**太字**`・地の文、マーカーの位置も先頭と
 * 末尾の両方がある）、揃った例だけで固めると実物で取りこぼす。
 */

const NOW = new Date("2026-08-25T00:00:00.000Z");

function issue(overrides: Partial<KnowledgeIssueNode> = {}): KnowledgeIssueNode {
  return {
    repo: "guchi-apps/issue-deck",
    number: 2286,
    title: "ログイン通知のWebhook URLをorganization secretとして追加する",
    url: "https://github.com/guchi-apps/issue-deck/issues/2286",
    state: "CLOSED",
    comments: [],
    ...overrides,
  };
}

function raw(overrides: Partial<GitHubKnowledgeRaw> = {}): GitHubKnowledgeRaw {
  return {
    repoUrl: "https://github.com/guchi-apps/docs",
    branch: "main",
    directories: [],
    issues: [],
    issueCount: 0,
    truncated: false,
    rateLimit: { remaining: 4900, resetAt: "2026-08-25T01:00:00Z" },
    failures: [],
    ...overrides,
  };
}

describe("parseKnowledgeFile", () => {
  it("`##` 見出しを知見として拾い、確認日と出典を対応づける", () => {
    const file = parseKnowledgeFile(
      "knowledge/notion.md",
      [
        "# Notion API の共通知見",
        "",
        "## API 2025-09-03 以降、対象はデータベースではなくデータソース",
        "",
        "- **状況**: `@notionhq/client` v5 以降を使うとき。",
        "- **確認日**: 2026-08-09",
        "- **出典リポジトリ**: guchi-apps/dayspan",
        "",
        "## プロパティ名は固定できない",
        "",
        "- **確認日**: 2026-08-10",
      ].join("\n"),
    );

    assert.equal(file.title, "Notion API の共通知見");
    assert.equal(file.name, "notion.md");
    assert.equal(file.isIndex, false);
    assert.equal(file.sections.length, 2);
    assert.equal(file.sections[0]?.confirmedAt, "2026-08-09");
    assert.equal(file.sections[0]?.source, "guchi-apps/dayspan");
    assert.equal(file.sections[1]?.confirmedAt, "2026-08-10");
    // 出典が書かれていない知見は null のままにする（前の知見の値を引き継がない）。
    assert.equal(file.sections[1]?.source, null);
  });

  it("コードフェンスの中の `##` を見出しと数えない", () => {
    // agent-rules/knowledge-contribution.md は書式の説明として `## <結論>` を囲みの中に持つ。
    const file = parseKnowledgeFile(
      "agent-rules/knowledge-contribution.md",
      ["# 知見の書き戻しルール", "", "## 判定基準", "", "```markdown", "## <一行で分かる結論>", "```", ""].join("\n"),
    );

    assert.deepEqual(
      file.sections.map((section) => section.title),
      ["判定基準"],
    );
  });

  it("README.md は索引として扱い、知見として数えない", () => {
    const file = parseKnowledgeFile("knowledge/README.md", "# knowledge索引\n\n## 一覧\n");
    assert.equal(file.isIndex, true);
  });
});

describe("parseMemoComment", () => {
  it("マーカーが末尾に1つだけのコメントから、太字の見出しを取る", () => {
    const items = parseMemoComment(
      [
        "**知見メモ**",
        "",
        "**organization secretが覆い隠されるのは同名のrepository secretがある場合だけ**",
        "",
        "- 確認日: 2026-08-25",
        "",
        CANDIDATE_MARKER,
        "<!-- issue-deck-agent:implementer -->",
      ].join("\n"),
    );

    assert.equal(items.length, 1);
    assert.equal(items[0]?.heading, "organization secretが覆い隠されるのは同名のrepository secretがある場合だけ");
    assert.equal(items[0]?.confirmedAt, "2026-08-25");
  });

  it("1コメントに知見が複数あるとき、マーカーごとに切り分ける", () => {
    const items = parseMemoComment(
      [
        CANDIDATE_MARKER,
        "### 既定のGITHUB_TOKENは.github/workflows/配下へpushできない",
        "",
        "- 確認日: 2026-08-09",
        "",
        CANDIDATE_MARKER,
        "### ワイルドカードAレコードがあるのでDNS登録は要らない",
        "",
        "- 確認日: 2026-08-25",
        "",
        "<!-- issue-deck-agent:implementer -->",
      ].join("\n"),
    );

    assert.deepEqual(
      items.map((item) => item.heading),
      ["既定のGITHUB_TOKENは.github/workflows/配下へpushできない", "ワイルドカードAレコードがあるのでDNS登録は要らない"],
    );
  });

  it("見出しが無い地の文でも落とさず、冒頭を見出しにする", () => {
    const items = parseMemoComment(
      `${CANDIDATE_MARKER}\n\npnpm 11 は VPS の Node 20 では動かないので packageManager を 10 系に固定する。\n`,
    );

    assert.equal(items.length, 1);
    assert.equal(items[0]?.heading, "pnpm 11 は VPS の Node 20 では動かないので packageManager を 10 系に固定する。");
  });

  it("マーカーしか無いコメントからは知見を作らない", () => {
    assert.deepEqual(parseMemoComment(`${CANDIDATE_MARKER}\n<!-- issue-deck-agent:implementer -->\n`), []);
  });

  it("囲みの中に貼られた書式の例では切らない", () => {
    // 書式を説明するメモは、例としてマーカーごと囲みへ貼る。そこで切ると
    // 例文が独立した知見として並んでしまう。
    const items = parseMemoComment(
      [
        CANDIDATE_MARKER,
        "### 知見メモの書式を決めた",
        "",
        "```markdown",
        CANDIDATE_MARKER,
        "### <一行で分かる結論>",
        "- 確認日: 2000-01-01",
        "```",
        "",
        "- 確認日: 2026-08-25",
      ].join("\n"),
    );

    assert.deepEqual(
      items.map((item) => item.heading),
      ["知見メモの書式を決めた"],
    );
    // 囲みの中の確認日を拾わない。
    assert.equal(items[0]?.confirmedAt, "2026-08-25");
  });
});

describe("parseVerdictComment", () => {
  it("承認・却下と理由・反映先を読み取る", () => {
    const notes = parseVerdictComment(
      [
        "### 共有知識への格上げ判定",
        "",
        "- ✅ 承認: 既定のGITHUB_TOKENでは配下へpushできない → `knowledge/github-actions.md`（既存セクションの更新）",
        "  - 理由: 全アプリのActionsに当てはまり、出典の実行ログがある",
        "- ❌ 却下: 画面のスクロール位置がリセットされる",
        "  - 理由: myroom固有の画面構成に依存する",
        "",
        JUDGED_MARKER,
      ].join("\n"),
    );

    assert.equal(notes.length, 2);
    assert.equal(notes[0]?.approved, true);
    assert.equal(notes[0]?.target, "knowledge/github-actions.md");
    assert.equal(notes[0]?.reason, "全アプリのActionsに当てはまり、出典の実行ログがある");
    assert.equal(notes[1]?.approved, false);
    assert.equal(notes[1]?.target, null);
    assert.equal(notes[1]?.reason, "myroom固有の画面構成に依存する");
  });

  it("判定行より先に出てきた理由は、どの知見にも結び付けない", () => {
    assert.deepEqual(parseVerdictComment("- 理由: 前置き\n"), []);
  });
});

describe("buildKnowledgeView", () => {
  it("知見メモがコメントに無いIssueは一覧に出さない", () => {
    // GitHubのIssue検索は本文も対象にするため、マーカーの文字列を本文に書いただけの
    // 設計Issue（guchi-apps/docs#65 など）が検索に混ざる。
    const view = buildKnowledgeView(
      raw({ issues: [issue({ comments: [{ body: "設計の説明", createdAt: "2026-08-20T00:00:00Z", url: "" }] })] }),
      NOW,
    );

    assert.deepEqual(view.memos, []);
    assert.equal(view.counts.items, 0);
  });

  it("この仕組みを設計したIssueを、判定済みにも知見メモにも数えない", () => {
    // guchi-apps/issue-deck#2029 で実際に起きた誤検出。運用を決めたIssueは、書式の説明として
    // マーカーを囲みの中や地の文へ貼るため、素の `includes` では全件が「却下」になっていた。
    const view = buildKnowledgeView(
      raw({
        issues: [
          issue({
            number: 2029,
            title: "共有知識の格上げ判定を専用エージェントで一元化する",
            comments: [
              {
                body: ["判定結果には次を付ける。", "", "```markdown", JUDGED_MARKER, "```"].join("\n"),
                createdAt: "2026-08-20T00:00:00Z",
                url: "",
              },
              {
                body: `知見メモは \`${CANDIDATE_MARKER}\` を先頭に置く。`,
                createdAt: "2026-08-20T01:00:00Z",
                url: "",
              },
              { body: "実装完了", createdAt: "2026-08-21T00:00:00Z", url: "" },
            ],
          }),
        ],
      }),
      NOW,
    );

    assert.deepEqual(view.memos, []);
    assert.equal(view.counts.rejected, 0);
  });

  it("判定コメントが無ければ未判定にし、滞留日数を数える", () => {
    const view = buildKnowledgeView(
      raw({
        issues: [
          issue({
            comments: [
              { body: `${CANDIDATE_MARKER}\n### 知見A\n`, createdAt: "2026-08-20T00:00:00Z", url: "" },
            ],
          }),
        ],
      }),
      NOW,
    );

    assert.equal(view.memos.length, 1);
    assert.equal(view.memos[0]?.verdict, "pending");
    assert.equal(view.memos[0]?.pendingDays, 5);
    assert.equal(view.counts.pending, 1);
    assert.equal(view.stalledDays, 5);
    assert.equal(view.oldestPendingAt, "2026-08-20T00:00:00Z");
  });

  it("承認が1件でもあれば採用、無ければ却下として数える", () => {
    const view = buildKnowledgeView(
      raw({
        issues: [
          issue({
            number: 1,
            comments: [
              { body: `${CANDIDATE_MARKER}\n### 知見A\n`, createdAt: "2026-08-20T00:00:00Z", url: "" },
              { body: `- ✅ 承認: 知見A → \`knowledge/a.md\`\n${JUDGED_MARKER}`, createdAt: "2026-08-23T00:00:00Z", url: "" },
            ],
          }),
          issue({
            number: 2,
            comments: [
              { body: `${CANDIDATE_MARKER}\n### 知見B\n`, createdAt: "2026-08-21T00:00:00Z", url: "" },
              { body: `- ❌ 却下: 知見B\n  - 理由: 重複\n${JUDGED_MARKER}`, createdAt: "2026-08-23T00:00:00Z", url: "" },
            ],
          }),
        ],
      }),
      NOW,
    );

    assert.equal(view.counts.approved, 1);
    assert.equal(view.counts.rejected, 1);
    assert.equal(view.counts.pending, 0);
    // 未判定が無ければ滞留も無い。
    assert.equal(view.stalledDays, null);
    // 新しい順に並ぶ。
    assert.deepEqual(
      view.memos.map((memo) => memo.number),
      [2, 1],
    );
  });

  it("知見の数で内訳を数える（1つのメモに3件書かれていたら3件）", () => {
    const body = [CANDIDATE_MARKER, "### 知見A", CANDIDATE_MARKER, "### 知見B", CANDIDATE_MARKER, "### 知見C"].join(
      "\n",
    );
    const view = buildKnowledgeView(
      raw({ issues: [issue({ comments: [{ body, createdAt: "2026-08-24T00:00:00Z", url: "" }] })] }),
      NOW,
    );

    assert.equal(view.counts.memos, 1);
    assert.equal(view.counts.items, 3);
    assert.equal(view.counts.pending, 3);
    assert.equal(view.sources[0]?.items, 3);
  });

  it("knowledge/ を採用済みとして分け、それ以外を別に持つ", () => {
    const view = buildKnowledgeView(
      raw({
        directories: [
          {
            path: "knowledge",
            files: [
              { path: "knowledge/a.md", text: "# A\n\n## 知見1\n\n## 知見2\n", truncated: false },
              { path: "knowledge/README.md", text: "# 索引\n\n## 一覧\n", truncated: false },
            ],
          },
          { path: "standards", files: [{ path: "standards/ports.md", text: "# ポート\n\n## 割り当て\n", truncated: false }] },
        ],
      }),
      NOW,
    );

    // README は索引なので件数に入れない。
    assert.equal(view.counts.adopted, 2);
    assert.equal(view.adopted?.path, "knowledge");
    assert.deepEqual(
      view.others.map((dir) => dir.path),
      ["standards"],
    );
  });
});

describe("emptyKnowledgeView", () => {
  it("トークン未設定なら configured が false で、件数はすべて0になる", () => {
    const view = emptyKnowledgeView(NOW);
    assert.equal(view.configured, false);
    assert.equal(view.counts.items, 0);
    assert.deepEqual(view.failures, []);
  });
});
