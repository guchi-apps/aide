/**
 * 開発状況を取るGraphQLクエリ。
 *
 * 取るフィールドは `RepoStatus` フラグメント1つに集約し、俯瞰用と詳細用の2オペレーションが
 * それを共有する。**フラグメントが1つなら型（`types.ts`）との対応も1対1に保てる。**
 * 掘る深さ（コミット数・Issue/PRのノード数）は変数で切り替える。
 *
 * **詳細モードで組織全体を引かないこと。** 当初は1クエリで全リポジトリを深く掘って
 * 1件に絞る実装にしていたが、GitHub側の処理が重く5秒のタイムアウトに掛かった（実測）。
 * コストは2ポイント前後で問題にならなかったが、応答時間は別問題だった。
 *
 * リポジトリ一覧は絞り込まずに取り、**対象の選別は `src/core/views/dev.ts` の純粋関数で行う**。
 * `pushedAt` によるフィルタや上限をGraphQL側に寄せるとテストできなくなるため。
 *
 * コストは実測で **26リポジトリ・全項目で2ポイント**（上限は1時間5000ポイント）。
 * 同じ内容をRESTで取ると約80リクエストかかる。
 */

/**
 * 一度に取得するリポジトリ数の上限。
 * guchi-apps は現在26。100を超えたらページングが要るが、その時点で「全部見る」こと自体を
 * 見直すほうが妥当なので、ここでは追いかけない。
 */
export const REPOSITORY_FETCH_LIMIT = 100;

/**
 * `compare` に渡す安定版ブランチ名。
 * デフォルトブランチ（`develop`）との差分が「未リリースの変更」にあたる。
 */
export const RELEASE_BRANCH = "main";

/**
 * ユーザーの確認待ちを表すラベル。issue-deck の運用ラベルで、全リポジトリ共通。
 * 進捗そのものは GitHub Projects の Status で管理されており、ラベルからは読めない。
 */
export const CHECK_USER_LABEL = "00.check-user";

/** 俯瞰モードで掘る深さ。件数（totalCount）は深さに関係なく正確に返る。 */
export const OVERVIEW_DEPTH = { commits: 1, issueNodes: 3 } as const;

/** 詳細モード（`repo` 指定時）で掘る深さ。 */
export const DETAIL_DEPTH = { commits: 5, issueNodes: 10 } as const;

/** 俯瞰用と詳細用で共有する、リポジトリ1件ぶんの取得内容。`types.ts` と1対1に対応する。 */
const REPO_STATUS_FRAGMENT = `
fragment RepoStatus on Repository {
  name
  url
  isPrivate
  pushedAt
  defaultBranchRef {
    name
    # base = デフォルトブランチ / head = main。behindBy が未リリース数になる（types.ts 参照）。
    compare(headRef: "${RELEASE_BRANCH}") {
      aheadBy
      behindBy
    }
    target {
      ... on Commit {
        history(first: $commits) {
          nodes {
            messageHeadline
            committedDate
          }
        }
        statusCheckRollup {
          state
        }
      }
    }
  }
  latestRelease {
    tagName
    publishedAt
  }
  issues(states: OPEN) {
    totalCount
  }
  pullRequests(
    states: OPEN
    first: $issueNodes
    orderBy: { field: UPDATED_AT, direction: DESC }
  ) {
    totalCount
    nodes {
      number
      title
      isDraft
      labels(first: 20) {
        nodes {
          name
        }
      }
    }
  }
  checkUser: issues(states: OPEN, labels: ["${CHECK_USER_LABEL}"], first: $issueNodes) {
    totalCount
    nodes {
      number
      title
    }
  }
}
`;

/** 俯瞰モード。Organization のリポジトリを push の新しい順にまとめて引く。 */
export const DEV_STATUS_QUERY = `
query DevStatus($org: String!, $repos: Int!, $commits: Int!, $issueNodes: Int!) {
  rateLimit {
    remaining
    resetAt
  }
  organization(login: $org) {
    repositories(
      first: $repos
      orderBy: { field: PUSHED_AT, direction: DESC }
      isArchived: false
    ) {
      nodes {
        ...RepoStatus
      }
    }
  }
}
${REPO_STATUS_FRAGMENT}`;

/**
 * 詳細モード。**1リポジトリだけを引く。**
 * 組織全体を深く掘ると5秒で返ってこないため、ここで対象を絞る必要がある。
 */
export const DEV_REPO_QUERY = `
query DevRepoStatus($org: String!, $repo: String!, $commits: Int!, $issueNodes: Int!) {
  rateLimit {
    remaining
    resetAt
  }
  repository(owner: $org, name: $repo) {
    ...RepoStatus
  }
}
${REPO_STATUS_FRAGMENT}`;
