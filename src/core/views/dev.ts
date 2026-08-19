import { fetchDevStatus, readGitHubConfig } from "../connectors/github/index.ts";
import {
  CHECK_USER_LABEL,
  DETAIL_DEPTH,
  LABEL_FETCH_LIMIT,
  OVERVIEW_DEPTH,
  RELEASE_BRANCH,
} from "../connectors/github/query.ts";
import type {
  GitHubDevRaw,
  GitHubRateLimit,
  GitHubRepositoryLabel,
  GitHubRepositoryNode,
  GitHubSourceFailure,
} from "../connectors/github/types.ts";

/**
 * 開発状況の横断ビュー。
 *
 * 「どのリポジトリがいまどうなっているか」に答えられる粒度まで畳む。返すのは**状態**
 * （最新リリース・未リリースの差分・open な Issue/PR・確認待ち・直近コミット・CIの成否）だけで、
 * **ソースコードやREADMEの本文は返さない**（Issue #32 のコメントで確定した方針。コードの詳細は
 * Claude Code（CLI）と issue-deck が担当する）。
 *
 * **キャッシュを挟まず、呼ばれるたびに取得する。** README「どこまでを『重い取得』とみなすか」で
 * いう都度叩く側にあたる。GraphQLの1リクエストで済み（実測2ポイント / 1時間5000ポイント）、
 * かつ「いまどうなっているか」という問いに対してキャッシュの古さは害にしかならない。
 */

/** 深刻度。`aide_ops_status` の `OpsSeverity` と同じ考え方。 */
export type DevSeverity = "ok" | "warn" | "danger";

/** CIの状態。GraphQL の `statusCheckRollup.state` を小文字化して丸めたもの。 */
export type DevCiState = "success" | "failure" | "error" | "pending" | "expected" | "unknown";

/**
 * しきい値と既定値。**ここだけを見れば判定基準が分かる**ようにまとめている。
 */
const DEFAULTS = {
  /** これより古いpushしかないリポジトリは「動いていない」とみなして対象から外す。 */
  activeDays: 90,
  /** 俯瞰で返すリポジトリ数の上限。全部並べても読む側の負担になるだけ。 */
  maxRepos: 20,
  /**
   * 未リリースのコミットがこれ以上溜まっていたら注意を促す。
   * 1件で出すと開発中は常時点灯してノイズにしかならない。
   */
  unreleasedCommits: 20,
} as const;

export interface DevAttention {
  severity: Exclude<DevSeverity, "ok">;
  message: string;
}

export interface DevCommit {
  message: string;
  at: string;
}

export interface DevIssueRef {
  number: number;
  title: string;
}

export interface DevPullRequestRef extends DevIssueRef {
  draft: boolean;
  /** `00.check-user` が付いているか。 */
  checkUser: boolean;
}

/**
 * リポジトリに定義されているラベル1件。
 *
 * **`aide_create_issue` に渡す候補**として返す。GitHubのIssue作成APIは未知のラベル名を
 * 渡すとラベルごと新規作成してしまうため（`src/core/connectors/github/write.ts`）、
 * 起票の前に実在する名前を確かめられる口が要る（#122）。
 */
export interface DevLabel {
  /** そのまま `aide_create_issue` の `labels` に渡せる表記。 */
  name: string;
  /** `#rrggbb`。GitHubは `#` 無しで返すので、ここで付けている。 */
  color: string;
  /** ラベルの説明。設定されていなければ null。 */
  description: string | null;
}

export interface DevRepoDetail {
  recentCommits: DevCommit[];
  /** `00.check-user` が付いた open Issue。 */
  checkUserIssues: DevIssueRef[];
  openPullRequests: DevPullRequestRef[];
  /** リポジトリに定義されているラベル（名前順）。 */
  labels: DevLabel[];
}

export interface DevRepoSummary {
  name: string;
  url: string;
  private: boolean;
  defaultBranch: string | null;
  pushedAt: string | null;
  latestRelease: { tag: string; publishedAt: string | null } | null;
  /**
   * develop/main のリリース運用をしているか。
   * デフォルトブランチが `main` 自身、または `main` が無いリポジトリでは false になり、
   * 差分は出さない（比べる相手がいないため）。
   */
  releaseFlow: boolean;
  /** デフォルトブランチが main より進んでいる数 ＝ 未リリースの変更。 */
  unreleasedCommits: number | null;
  /** main がデフォルトブランチより進んでいる数（リリースのマージコミット等）。 */
  mainAheadCommits: number | null;
  ci: DevCiState | null;
  openIssues: number;
  openPullRequests: number;
  /** `00.check-user` が付いた open Issue の件数。 */
  checkUser: number;
  lastCommit: DevCommit | null;
  /** `repo` を指定して呼んだときだけ入る。 */
  detail?: DevRepoDetail;
}

export interface DevStatus {
  checkedAt: string;
  /** GitHubへの接続が設定されているか。false なら以下はすべて空。 */
  configured: boolean;
  org: string | null;
  /** 何を対象にしたかの説明。返っていないリポジトリがある理由がこれで分かる。 */
  scope: string;
  /** 判定できた範囲で注意すべきことが無いか。**材料を1つも取得できなかった場合も false。** */
  ok: boolean;
  severity: DevSeverity;
  /** すべて取得できたか。false なら `ok` は「見えている範囲では」の意味になる。 */
  complete: boolean;
  attention: DevAttention[];
  repos: DevRepoSummary[];
  /** GraphQLの残ポイント（1時間5000）。 */
  rateLimit: GitHubRateLimit | null;
  /** 取得できなかったもの。 */
  unavailable: GitHubSourceFailure[];
  note: string;
}

function worst(severities: DevSeverity[]): DevSeverity {
  if (severities.includes("danger")) return "danger";
  if (severities.includes("warn")) return "warn";
  return "ok";
}

/** 環境変数から正の整数を読む。壊れた値は既定値に倒す（起動を止めるほどの設定ではない）。 */
function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** `AIDE_GITHUB_REPOS` の明示指定。カンマ区切り。空なら null（＝自動抽出）。 */
function readExplicitRepos(): string[] | null {
  const raw = process.env["AIDE_GITHUB_REPOS"];
  if (!raw) return null;
  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  return names.length > 0 ? names : null;
}

export interface DevScopeOptions {
  /** 明示指定されたリポジトリ名。null なら `activeDays` で自動抽出する。 */
  explicitRepos: string[] | null;
  activeDays: number;
  maxRepos: number;
  /** 1リポジトリに絞り込む（詳細モード）。 */
  repo?: string | undefined;
}

/**
 * 対象リポジトリを選ぶ。**GraphQL側ではなくここで絞る**（テストできるようにするため）。
 *
 * `repositories` は pushedAt の新しい順で渡ってくる前提。
 */
export function selectRepositories(
  repositories: GitHubRepositoryNode[],
  options: DevScopeOptions,
  now: Date,
): { selected: GitHubRepositoryNode[]; scope: string } {
  if (options.repo) {
    const name = options.repo.toLowerCase();
    const found = repositories.filter((repo) => repo.name.toLowerCase() === name);
    return {
      selected: found,
      scope:
        found.length > 0
          ? `リポジトリ ${found[0]!.name} のみ`
          : `リポジトリ ${options.repo} は見つからなかった（archived か、名前が違うか、権限が無い）`,
    };
  }

  if (options.explicitRepos) {
    const wanted = new Set(options.explicitRepos.map((name) => name.toLowerCase()));
    return {
      selected: repositories.filter((repo) => wanted.has(repo.name.toLowerCase())),
      scope: `AIDE_GITHUB_REPOS で指定されたリポジトリ（${options.explicitRepos.length}件）`,
    };
  }

  const activeSince = now.getTime() - options.activeDays * 86_400_000;
  const active = repositories.filter((repo) => {
    if (!repo.pushedAt) return false;
    const at = new Date(repo.pushedAt).getTime();
    return Number.isFinite(at) && at >= activeSince;
  });

  const selected = active.slice(0, options.maxRepos);
  const omitted = active.length - selected.length;

  return {
    selected,
    scope:
      `archived を除き、直近${options.activeDays}日にpushがあったリポジトリ` +
      `（${active.length}件中 ${selected.length}件）` +
      (omitted > 0 ? `。pushが古い${omitted}件は省いている` : ""),
  };
}

function toCiState(state: string | undefined | null): DevCiState | null {
  if (!state) return null;
  switch (state) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
      return "failure";
    case "ERROR":
      return "error";
    case "PENDING":
      return "pending";
    case "EXPECTED":
      return "expected";
    default:
      return "unknown";
  }
}

function toCommit(node: { messageHeadline: string; committedDate: string }): DevCommit {
  return { message: node.messageHeadline, at: node.committedDate };
}

/**
 * ラベル定義を候補として使える形へ畳む。
 *
 * 色は `#` を補うだけで、名前と説明はGitHubの表記をそのまま渡す
 * （**加工すると `aide_create_issue` にそのまま渡せなくなる**）。
 */
function toLabels(nodes: (GitHubRepositoryLabel | null)[]): DevLabel[] {
  return nodes
    .filter((node): node is GitHubRepositoryLabel => node !== null)
    .map((node) => ({
      name: node.name,
      color: node.color.startsWith("#") ? node.color : `#${node.color}`,
      description: node.description ?? null,
    }));
}

function summarizeRepo(repo: GitHubRepositoryNode, withDetail: boolean): DevRepoSummary {
  const branch = repo.defaultBranchRef ?? null;
  const commits = branch?.target?.history?.nodes ?? [];

  // `main` 自身がデフォルトのリポジトリ・`main` が無いリポジトリ（master 運用）には
  // 比べる相手がいない。compare は前者で 0/0、後者で null を返すので両方を弾く。
  const releaseFlow = branch !== null && branch.name !== RELEASE_BRANCH && Boolean(branch.compare);
  const compare = releaseFlow ? branch!.compare! : null;

  const pullRequestNodes = repo.pullRequests?.nodes ?? [];

  const summary: DevRepoSummary = {
    name: repo.name,
    url: repo.url,
    private: repo.isPrivate,
    defaultBranch: branch?.name ?? null,
    pushedAt: repo.pushedAt,
    latestRelease: repo.latestRelease
      ? { tag: repo.latestRelease.tagName, publishedAt: repo.latestRelease.publishedAt }
      : null,
    releaseFlow,
    // types.ts のとおり、behindBy が「デフォルトブランチが main より進んでいる数」。
    unreleasedCommits: compare ? compare.behindBy : null,
    mainAheadCommits: compare ? compare.aheadBy : null,
    ci: toCiState(branch?.target?.statusCheckRollup?.state),
    openIssues: repo.issues?.totalCount ?? 0,
    openPullRequests: repo.pullRequests?.totalCount ?? 0,
    checkUser: repo.checkUser?.totalCount ?? 0,
    lastCommit: commits[0] ? toCommit(commits[0]) : null,
  };

  if (withDetail) {
    summary.detail = {
      recentCommits: commits.map(toCommit),
      checkUserIssues: (repo.checkUser?.nodes ?? []).map(({ number, title }) => ({ number, title })),
      openPullRequests: pullRequestNodes.map((pr) => ({
        number: pr.number,
        title: pr.title,
        draft: pr.isDraft,
        checkUser: (pr.labels?.nodes ?? []).some((label) => label.name === CHECK_USER_LABEL),
      })),
      labels: toLabels(repo.labels?.nodes ?? []),
    };
  }

  return summary;
}

/** リポジトリ1件ぶんの注意点を洗い出す。 */
function repoAttention(repo: DevRepoSummary, unreleasedLimit: number): DevAttention[] {
  const attention: DevAttention[] = [];

  if (repo.ci === "failure" || repo.ci === "error") {
    attention.push({
      severity: "danger",
      message: `${repo.name}: ${repo.defaultBranch ?? "デフォルトブランチ"} のCIが失敗している`,
    });
  }
  if (repo.checkUser > 0) {
    attention.push({
      severity: "warn",
      message: `${repo.name}: 確認待ち（${CHECK_USER_LABEL}）のIssueが ${repo.checkUser}件`,
    });
  }
  if (repo.unreleasedCommits !== null && repo.unreleasedCommits >= unreleasedLimit) {
    attention.push({
      severity: "warn",
      message:
        `${repo.name}: ${RELEASE_BRANCH} へ未反映のコミットが ${repo.unreleasedCommits}件` +
        `（最新リリース ${repo.latestRelease?.tag ?? "なし"}）`,
    });
  }

  return attention;
}

export interface SummarizeDevOptions extends DevScopeOptions {
  unreleasedLimit: number;
  org: string;
}

/**
 * 取得結果を「いまどのリポジトリがどうなっているか」の粒度へ畳む。
 * **純粋関数。テストはここに集中する。**
 */
export function summarizeDev(raw: GitHubDevRaw, options: SummarizeDevOptions, now: Date): DevStatus {
  const { selected, scope } = selectRepositories(raw.repositories, options, now);
  const withDetail = Boolean(options.repo);
  const repos = selected.map((repo) => summarizeRepo(repo, withDetail));
  const attention = repos.flatMap((repo) => repoAttention(repo, options.unreleasedLimit));

  const complete = raw.failures.length === 0;

  const notes = [
    "GitHubが持っている状態をそのまま読んでいる。返すのは状態の俯瞰までで、" +
      "ソースコードやREADMEの本文は返さない（コードの詳細はClaude CodeとIssue-deckが担当）。",
  ];
  if (!complete) {
    notes.push("一部を取得できなかったため、注意点が無いと判定した範囲は限定的。");
  }
  if (repos.length === 0) {
    notes.push("対象のリポジトリが1件も無い。scope を見ること。");
  }
  if (!withDetail) {
    notes.push(
      "個別のIssue・PR・コミットの一覧と、起票に使えるラベルの候補が要るときは " +
        "repo にリポジトリ名を指定して呼ぶ。",
    );
  } else {
    notes.push(
      "detail.labels はそのリポジトリに実在するラベル。" +
        "aide_create_issue の labels にはここにある名前だけを渡すこと。",
    );
    // **省いたなら省いたと書く。** 100件で切れていることに気づかないまま
    // 「候補はこれで全部」と読まれると、実在するラベルを無いものとして扱ってしまう。
    const omittedLabels = selected.reduce((total, repo) => {
      const fetched = repo.labels?.nodes?.length ?? 0;
      return total + Math.max(0, (repo.labels?.totalCount ?? fetched) - fetched);
    }, 0);
    if (omittedLabels > 0) {
      notes.push(`ラベルは${LABEL_FETCH_LIMIT}件までしか返しておらず、${omittedLabels}件は省いている。`);
    }
  }

  return {
    checkedAt: now.toISOString(),
    configured: true,
    org: options.org,
    scope,
    // 何も取得できていない状態を `ok: true` で返すと「問題なし」と読まれる。
    ok: repos.length > 0 && attention.length === 0,
    severity: worst([...attention.map((item) => item.severity), complete ? "ok" : "warn"]),
    complete,
    attention,
    repos,
    rateLimit: raw.rateLimit,
    unavailable: raw.failures,
    note: notes.join(" "),
  };
}

/** GitHubへの接続が設定されていないときの答え。 */
function notConfiguredStatus(now: Date): DevStatus {
  return {
    checkedAt: now.toISOString(),
    configured: false,
    org: null,
    scope: "未設定のため対象なし",
    ok: false,
    severity: "warn",
    complete: false,
    attention: [],
    repos: [],
    rateLimit: null,
    unavailable: [{ source: "github", reason: "接続が設定されていない" }],
    note:
      "AIDE_GITHUB_TOKEN が設定されていないため、開発状況を取得できない。" +
      "設定するまでこのツールは何も答えられない（問題が無いという意味ではない）。",
  };
}

/** MCPツールから呼ばれる入口。設定を読み、取得し、畳む。 */
export async function buildDevStatus(repo?: string): Promise<DevStatus> {
  const now = new Date();
  const config = readGitHubConfig();
  if (!config) return notConfiguredStatus(now);

  // 詳細モードでは取得側でも1リポジトリに絞る。組織全体を深く掘るとGitHub側の処理が重く、
  // 5秒のタイムアウトに掛かる（実測）。コストではなく応答時間の問題。
  const depth = repo ? DETAIL_DEPTH : OVERVIEW_DEPTH;
  const raw = await fetchDevStatus(config, {
    commits: depth.commits,
    issueNodes: depth.issueNodes,
    repo,
  });

  return summarizeDev(
    raw,
    {
      org: config.org,
      repo,
      explicitRepos: readExplicitRepos(),
      activeDays: readPositiveInt("AIDE_GITHUB_ACTIVE_DAYS", DEFAULTS.activeDays),
      maxRepos: DEFAULTS.maxRepos,
      unreleasedLimit: DEFAULTS.unreleasedCommits,
    },
    now,
  );
}
