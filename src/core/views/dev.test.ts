import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { selectRepositories, summarizeDev, type SummarizeDevOptions } from "./dev.ts";
import type { GitHubDevRaw, GitHubRepositoryNode } from "../connectors/github/types.ts";

/**
 * `summarizeDev` / `selectRepositories` は純粋関数なので、テストはここに集中させる。
 * コネクタ（GraphQL）側はGitHubの実物が契約なので、ここでは触らない。
 */

const NOW = new Date("2026-08-16T00:00:00.000Z");

function repo(overrides: Partial<GitHubRepositoryNode> = {}): GitHubRepositoryNode {
  return {
    name: "aide",
    url: "https://github.com/guchi-apps/aide",
    isPrivate: false,
    pushedAt: "2026-08-15T23:57:36Z",
    defaultBranchRef: {
      name: "develop",
      compare: { aheadBy: 0, behindBy: 0 },
      target: {
        history: { nodes: [{ messageHeadline: "直近のコミット", committedDate: "2026-08-15T23:57:00Z" }] },
        statusCheckRollup: { state: "SUCCESS" },
      },
    },
    latestRelease: { tagName: "v0.3.0", publishedAt: "2026-08-15T20:00:00Z" },
    issues: { totalCount: 8 },
    pullRequests: { totalCount: 1, nodes: [] },
    checkUser: { totalCount: 0, nodes: [] },
    ...overrides,
  };
}

function raw(overrides: Partial<GitHubDevRaw> = {}): GitHubDevRaw {
  return { repositories: [repo()], rateLimit: { remaining: 4900, resetAt: "2026-08-16T01:00:00Z" }, failures: [], ...overrides };
}

function options(overrides: Partial<SummarizeDevOptions> = {}): SummarizeDevOptions {
  return {
    org: "guchi-apps",
    explicitRepos: null,
    activeDays: 90,
    maxRepos: 20,
    unreleasedLimit: 20,
    ...overrides,
  };
}

describe("selectRepositories", () => {
  it("直近にpushが無いリポジトリを対象から外す", () => {
    const repositories = [
      repo({ name: "aide", pushedAt: "2026-08-15T23:57:36Z" }),
      repo({ name: "wifi-speed", pushedAt: "2026-02-06T08:13:18Z" }),
    ];

    const { selected, scope } = selectRepositories(repositories, options(), NOW);

    assert.deepEqual(
      selected.map((item) => item.name),
      ["aide"],
    );
    assert.match(scope, /直近90日/);
  });

  it("pushedAt が無いリポジトリは対象にしない", () => {
    const { selected } = selectRepositories([repo({ pushedAt: null })], options(), NOW);
    assert.equal(selected.length, 0);
  });

  it("上限を超えたぶんは省き、省いたことを scope に書く", () => {
    const repositories = [repo({ name: "a" }), repo({ name: "b" }), repo({ name: "c" })];

    const { selected, scope } = selectRepositories(repositories, options({ maxRepos: 2 }), NOW);

    assert.deepEqual(
      selected.map((item) => item.name),
      ["a", "b"],
    );
    // 黙って切ると「これが全部」と読まれる。
    assert.match(scope, /1件は省いている/);
  });

  it("AIDE_GITHUB_REPOS 相当の明示指定があれば、pushの新しさに関係なくそれだけを返す", () => {
    const repositories = [
      repo({ name: "aide" }),
      repo({ name: "wifi-speed", pushedAt: "2026-02-06T08:13:18Z" }),
    ];

    const { selected } = selectRepositories(
      repositories,
      options({ explicitRepos: ["wifi-speed"] }),
      NOW,
    );

    assert.deepEqual(
      selected.map((item) => item.name),
      ["wifi-speed"],
    );
  });

  it("repo 指定は大文字小文字を問わない", () => {
    const { selected } = selectRepositories([repo({ name: "issue-deck" })], options({ repo: "Issue-Deck" }), NOW);
    assert.deepEqual(
      selected.map((item) => item.name),
      ["issue-deck"],
    );
  });

  it("repo 指定が見つからないときは、見つからなかったことを scope に書く", () => {
    const { selected, scope } = selectRepositories([repo()], options({ repo: "存在しない" }), NOW);
    assert.equal(selected.length, 0);
    assert.match(scope, /見つからなかった/);
  });
});

describe("summarizeDev", () => {
  it("問題が無ければ ok を返す", () => {
    const status = summarizeDev(raw(), options(), NOW);

    assert.equal(status.configured, true);
    assert.equal(status.ok, true);
    assert.equal(status.severity, "ok");
    assert.equal(status.complete, true);
    assert.deepEqual(status.attention, []);
    assert.equal(status.repos.length, 1);
    assert.equal(status.repos[0]?.latestRelease?.tag, "v0.3.0");
    assert.equal(status.repos[0]?.ci, "success");
    assert.equal(status.repos[0]?.lastCommit?.message, "直近のコミット");
  });

  it("対象が1件も無ければ ok を false にする（問題が無いという意味ではない）", () => {
    const status = summarizeDev(raw({ repositories: [] }), options(), NOW);
    assert.equal(status.ok, false);
    assert.match(status.note, /1件も無い/);
  });

  /**
   * `compare` の向きは直感に反するので、ここで固定しておく。
   * `defaultBranchRef.compare(headRef:"main")` は base=デフォルトブランチ / head=main なので、
   * `behindBy` が「デフォルトブランチが main より進んでいる数」＝未リリース数になる。
   * REST の `compare/main...develop` と突き合わせて確認済み（issue-deck: ahead 6 / behind 81）。
   */
  it("compare の behindBy を未リリース数として読む", () => {
    const status = summarizeDev(
      raw({
        repositories: [
          repo({
            name: "issue-deck",
            defaultBranchRef: {
              name: "develop",
              compare: { aheadBy: 81, behindBy: 6 },
              target: { history: { nodes: [] }, statusCheckRollup: null },
            },
          }),
        ],
      }),
      options(),
      NOW,
    );

    assert.equal(status.repos[0]?.releaseFlow, true);
    assert.equal(status.repos[0]?.unreleasedCommits, 6);
    assert.equal(status.repos[0]?.mainAheadCommits, 81);
  });

  it("デフォルトブランチが main のリポジトリでは差分を出さない", () => {
    const status = summarizeDev(
      raw({
        repositories: [
          repo({
            name: "vps",
            defaultBranchRef: {
              name: "main",
              compare: { aheadBy: 0, behindBy: 0 },
              target: { history: { nodes: [] }, statusCheckRollup: null },
            },
          }),
        ],
      }),
      options(),
      NOW,
    );

    assert.equal(status.repos[0]?.releaseFlow, false);
    assert.equal(status.repos[0]?.unreleasedCommits, null);
  });

  it("main が無いリポジトリ（master 運用）でも差分を出さない", () => {
    const status = summarizeDev(
      raw({
        repositories: [
          repo({
            name: "sensor_260531",
            defaultBranchRef: {
              name: "master",
              compare: null,
              target: { history: { nodes: [] }, statusCheckRollup: null },
            },
          }),
        ],
      }),
      options(),
      NOW,
    );

    assert.equal(status.repos[0]?.releaseFlow, false);
    assert.equal(status.repos[0]?.unreleasedCommits, null);
  });

  it("CIの失敗を danger として attention に出す", () => {
    const status = summarizeDev(
      raw({
        repositories: [
          repo({
            defaultBranchRef: {
              name: "develop",
              compare: { aheadBy: 0, behindBy: 0 },
              target: { history: { nodes: [] }, statusCheckRollup: { state: "FAILURE" } },
            },
          }),
        ],
      }),
      options(),
      NOW,
    );

    assert.equal(status.repos[0]?.ci, "failure");
    assert.equal(status.severity, "danger");
    assert.equal(status.ok, false);
    assert.match(status.attention[0]!.message, /CIが失敗/);
  });

  it("CIが無いリポジトリは null にする（失敗ではない）", () => {
    const status = summarizeDev(raw({ repositories: [repo({
      defaultBranchRef: {
        name: "develop",
        compare: { aheadBy: 0, behindBy: 0 },
        target: { history: { nodes: [] }, statusCheckRollup: null },
      },
    })] }), options(), NOW);

    assert.equal(status.repos[0]?.ci, null);
    assert.equal(status.ok, true);
  });

  it("確認待ちのIssueがあれば warn として出す", () => {
    const status = summarizeDev(
      raw({ repositories: [repo({ checkUser: { totalCount: 2, nodes: [{ number: 32, title: "GitHubの開発状況" }] } })] }),
      options(),
      NOW,
    );

    assert.equal(status.repos[0]?.checkUser, 2);
    assert.equal(status.severity, "warn");
    assert.match(status.attention[0]!.message, /確認待ち.*2件/);
  });

  it("未リリースがしきい値未満なら attention に出さない（開発中は常時溜まるため）", () => {
    const build = (behindBy: number) =>
      summarizeDev(
        raw({
          repositories: [
            repo({
              defaultBranchRef: {
                name: "develop",
                compare: { aheadBy: 0, behindBy },
                target: { history: { nodes: [] }, statusCheckRollup: null },
              },
            }),
          ],
        }),
        options({ unreleasedLimit: 20 }),
        NOW,
      );

    assert.deepEqual(build(19).attention, []);
    assert.match(build(20).attention[0]!.message, /未反映のコミットが 20件/);
  });

  it("repo 指定のときだけ Issue・PR・コミットの一覧を返す", () => {
    const target = repo({
      defaultBranchRef: {
        name: "develop",
        compare: { aheadBy: 0, behindBy: 0 },
        target: {
          history: {
            nodes: [
              { messageHeadline: "1件目", committedDate: "2026-08-15T23:57:00Z" },
              { messageHeadline: "2件目", committedDate: "2026-08-15T22:00:00Z" },
            ],
          },
          statusCheckRollup: { state: "SUCCESS" },
        },
      },
      pullRequests: {
        totalCount: 1,
        nodes: [
          { number: 45, title: "GitHubの開発状況を返す", isDraft: false, labels: { nodes: [{ name: "00.check-user" }] } },
        ],
      },
      checkUser: { totalCount: 1, nodes: [{ number: 32, title: "GitHubの開発状況をMCPで返せるようにする" }] },
    });

    const overview = summarizeDev(raw({ repositories: [target] }), options(), NOW);
    assert.equal(overview.repos[0]?.detail, undefined);
    assert.match(overview.note, /repo にリポジトリ名を指定/);

    const detailed = summarizeDev(raw({ repositories: [target] }), options({ repo: "aide" }), NOW);
    const detail = detailed.repos[0]?.detail;
    assert.equal(detail?.recentCommits.length, 2);
    assert.deepEqual(detail?.checkUserIssues, [{ number: 32, title: "GitHubの開発状況をMCPで返せるようにする" }]);
    assert.equal(detail?.openPullRequests[0]?.checkUser, true);
    assert.equal(detail?.openPullRequests[0]?.draft, false);
  });

  it("取得に失敗したものがあれば complete を false にし、理由を残す", () => {
    const status = summarizeDev(
      raw({ failures: [{ source: "github", reason: "HTTP 401（トークンが無効）" }] }),
      options(),
      NOW,
    );

    assert.equal(status.complete, false);
    assert.equal(status.severity, "warn");
    assert.deepEqual(status.unavailable, [{ source: "github", reason: "HTTP 401（トークンが無効）" }]);
    assert.match(status.note, /限定的/);
  });

  it("欠けたフィールドがあっても落ちない（GraphQLは部分的に返ることがある）", () => {
    const status = summarizeDev(
      raw({
        repositories: [
          {
            name: "gucchii-os",
            url: "https://github.com/guchi-apps/gucchii-os",
            isPrivate: false,
            pushedAt: "2026-08-15T00:00:00Z",
          },
        ],
      }),
      options(),
      NOW,
    );

    const summary = status.repos[0];
    assert.equal(summary?.defaultBranch, null);
    assert.equal(summary?.latestRelease, null);
    assert.equal(summary?.releaseFlow, false);
    assert.equal(summary?.openIssues, 0);
    assert.equal(summary?.lastCommit, null);
  });
});
