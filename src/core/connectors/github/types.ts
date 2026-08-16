/**
 * GitHub GraphQL API (v4) のレスポンスのうち、AIDEが実際に使うフィールドだけを再宣言したもの。
 *
 * ops-dashboard のコネクタと同じ流儀で、**使う範囲を明示的に絞ること自体が目的**。
 * GraphQLは要求したフィールドしか返さないため、ここに書いた形がそのまま
 * `query.ts` のクエリと1対1で対応する。片方を変えたらもう片方も変える。
 *
 * 正本は https://docs.github.com/graphql のスキーマ。
 */

/** コミット1件。メッセージは見出し行だけ（本文まで返すとコンテキストを食う）。 */
export interface GitHubCommitNode {
  messageHeadline: string;
  committedDate: string;
}

/**
 * デフォルトブランチと main の比較。
 *
 * **向きに注意。** `defaultBranchRef.compare(headRef:"main")` は base=デフォルトブランチ・
 * head=main になるため、フィールドの意味は次のとおり（RESTの `compare/main...develop` と
 * 突き合わせて確認済み）。
 *
 * - `behindBy` = main がデフォルトブランチより遅れている数 ＝ **未リリースのコミット数**
 * - `aheadBy`  = main がデフォルトブランチより進んでいる数（リリースのマージコミット等）
 */
export interface GitHubComparison {
  aheadBy: number;
  behindBy: number;
}

/**
 * デフォルトブランチ先端のCI結果。
 * `EXPECTED` / `ERROR` / `FAILURE` / `PENDING` / `SUCCESS`。CIが無いリポジトリでは null。
 */
export interface GitHubStatusCheckRollup {
  state: string;
}

export interface GitHubCommitTarget {
  /** 新しい順。件数はクエリ変数で切り替える。 */
  history?: { nodes: GitHubCommitNode[] } | null;
  statusCheckRollup?: GitHubStatusCheckRollup | null;
}

export interface GitHubDefaultBranchRef {
  name: string;
  /** main が存在しないリポジトリ（master 運用等）では null。 */
  compare?: GitHubComparison | null;
  /** Commit 以外（アノテーテッドタグ等）が先端になることは無いが、型上は空になりうる。 */
  target?: GitHubCommitTarget | null;
}

export interface GitHubRelease {
  tagName: string;
  publishedAt: string | null;
}

export interface GitHubLabel {
  name: string;
}

export interface GitHubIssueNode {
  number: number;
  title: string;
}

export interface GitHubPullRequestNode {
  number: number;
  title: string;
  isDraft: boolean;
  labels?: { nodes: GitHubLabel[] } | null;
}

/** リポジトリ1件ぶん。`query.ts` の RepoStatus フラグメントと対応する。 */
export interface GitHubRepositoryNode {
  name: string;
  url: string;
  isPrivate: boolean;
  /** 最後にpushされた時刻（ISO8601）。対象リポジトリの絞り込みに使う。 */
  pushedAt: string | null;
  defaultBranchRef?: GitHubDefaultBranchRef | null;
  latestRelease?: GitHubRelease | null;
  issues?: { totalCount: number } | null;
  pullRequests?: { totalCount: number; nodes: GitHubPullRequestNode[] } | null;
  /** `00.check-user` が付いた open Issue。エイリアスでもう一度 issues を引いている。 */
  checkUser?: { totalCount: number; nodes: GitHubIssueNode[] } | null;
}

/** 残ポイント。GitHubのGraphQLは1時間5000ポイント制。 */
export interface GitHubRateLimit {
  remaining: number;
  resetAt: string;
}

/** GraphQLの `data`。部分的に取れることがあるので、どのフィールドも欠けうる前提で扱う。 */
export interface GitHubGraphQlData {
  rateLimit?: GitHubRateLimit | null;
  /** 俯瞰モード（`DEV_STATUS_QUERY`）で埋まる。 */
  organization?: { repositories?: { nodes: (GitHubRepositoryNode | null)[] } | null } | null;
  /** 詳細モード（`DEV_REPO_QUERY`）で埋まる。存在しない・権限が無いリポジトリでは null。 */
  repository?: GitHubRepositoryNode | null;
}

/** 取得できなかったもの。落ちたこと自体が情報なので、握りつぶさず返す。 */
export interface GitHubSourceFailure {
  source: string;
  /** 失敗の理由。**URL・ヘッダ・トークンは載せない**（HTTPステータスと例外名まで）。 */
  reason: string;
}

/**
 * GitHubから取れたものを、整形せずそのまま束ねたもの。
 *
 * GraphQLは **HTTP 200 でも `errors` を返し、`data` が部分的に埋まる**ことがあるため、
 * 「失敗したか」と「何が取れたか」を別々に持つ。
 */
export interface GitHubDevRaw {
  repositories: GitHubRepositoryNode[];
  rateLimit: GitHubRateLimit | null;
  failures: GitHubSourceFailure[];
}
