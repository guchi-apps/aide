import { describeFailure, type GitHubConfig } from "./index.ts";
import type { GitHubRateLimit, GitHubSourceFailure } from "./types.ts";

/**
 * 共有知識（`guchi-apps/docs`）とフリート全体の知見メモを取るコネクタ。
 *
 * **開発状況（`query.ts` / `index.ts`）とは材料も掘り方も別**なので、クエリ・型・取得を
 * このファイルにまとめている。あちらはOrganizationのリポジトリを横に舐めるのに対し、
 * ここは「1リポジトリのファイル」と「全リポジトリのIssueコメント」という2本立てで、
 * 共有するフラグメントも型も無い。
 *
 * 取るものは2つ。
 *
 * 1. `guchi-apps/docs` のディレクトリの中身（Markdownの本文まで）。**採用済みの共通知識**にあたる
 * 2. フリート各リポジトリのIssueに残った知見メモ（`<!-- knowledge-candidate -->`）と、
 *    それに対する格上げ判定（`<!-- knowledge-promotion:judged -->`）のコメント
 *
 * 2は `guchi-apps/docs` の `promote-knowledge.yml` が毎日巡回しているのと同じ材料を、
 * 同じ検索語で引いている。**判定はここでは行わない**（判定エージェントの仕事であり、
 * AIDEは取得・整形に徹するというREADMEの責務分担に従う）。
 *
 * 整形は `src/core/views/knowledge.ts` の仕事で、ここは取ってきた形をそのまま返す。
 */

const GRAPHQL_ENDPOINT = "https://api.github.com/graphql";

/** 共有知識リポジトリの名前。Organizationは `GitHubConfig.org` を使う。 */
export const DOCS_REPO = "docs";

/**
 * 一覧に出すディレクトリと、GraphQLのエイリアス名。
 *
 * **エイリアスに `-` を使えない**ため（GraphQLの名前規則）、`agent-rules` は `agentRules` で引く。
 * 表示順もこの並びで、`knowledge/` を先頭に置いている（格上げ判定の反映先はここだけ）。
 */
export const SHARED_DIRECTORIES = [
  { alias: "knowledge", path: "knowledge" },
  { alias: "agentRules", path: "agent-rules" },
  { alias: "standards", path: "standards" },
  { alias: "guides", path: "guides" },
  { alias: "templates", path: "templates" },
] as const;

/** 格上げ判定の反映先になるディレクトリ。ここだけを「採用済みの知見」として数える。 */
export const PROMOTION_DIRECTORY = "knowledge";

/**
 * 制限時間。
 *
 * 開発状況（10秒）より長い。**Issue検索はコメント本文まで返させるため実測2〜3秒**かかり、
 * ページを2回めくると合計で開発状況より重くなる。相手が詰まったときに画面ごと固まらせない
 * ためのものなので、実測の数倍を取っている。
 */
const TIMEOUT_MS = 20_000;

/** 1ページあたりのIssue数。GraphQLの `search` の上限。 */
const ISSUES_PER_PAGE = 100;

/**
 * めくるページ数の上限。
 *
 * 2026-08-25 時点で知見メモを持つIssueは181件あり、2ページで全部入る。**上限に達したことは
 * `truncated` で返す**（黙って切ると「全部見た」と読めてしまう）。
 */
const MAX_PAGES = 2;

/**
 * 1Issueあたり読むコメント数（末尾から）。
 *
 * 知見メモも判定結果も**実装が終わったあとに投稿される**ので、末尾から見れば足りる。
 * 実測では181件すべてが末尾20件以内に収まっていたが、余裕を見て30件にしている。
 */
const COMMENTS_PER_ISSUE = 30;

/** 知見メモを探す検索語。`promote-knowledge.yml` が使っているものと同じにしてある。 */
const MEMO_SEARCH_TERM = "knowledge-candidate";

const DOCS_QUERY = `
query SharedKnowledge($org: String!, $repo: String!) {
  rateLimit { remaining resetAt }
  repository(owner: $org, name: $repo) {
    url
    defaultBranchRef { name }
${SHARED_DIRECTORIES.map(
  (dir) => `    ${dir.alias}: object(expression: "HEAD:${dir.path}") { ...DirEntries }`,
).join("\n")}
  }
}
fragment DirEntries on GitObject {
  ... on Tree {
    entries {
      name
      type
      object { ... on Blob { byteSize isTruncated text } }
    }
  }
}`;

const MEMO_QUERY = `
query KnowledgeMemos($q: String!, $issues: Int!, $comments: Int!, $after: String) {
  rateLimit { remaining resetAt }
  search(query: $q, type: ISSUE, first: $issues, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on Issue {
        number
        title
        url
        state
        repository { nameWithOwner }
        comments(last: $comments) { totalCount nodes { body createdAt url } }
      }
    }
  }
}`;

/** ディレクトリの中のファイル1件。本文が取れないもの（サブディレクトリ・バイナリ）は落とす。 */
export interface KnowledgeBlob {
  /** リポジトリのルートからの相対パス（`knowledge/notion.md`）。 */
  path: string;
  text: string;
  /** GitHubが本文を切り詰めた場合。切れた本文から見出しを数えると件数が減るため区別する。 */
  truncated: boolean;
}

export interface KnowledgeDirectoryRaw {
  path: string;
  files: KnowledgeBlob[];
}

/** Issueコメント1件。 */
export interface KnowledgeCommentNode {
  body: string;
  createdAt: string;
  url: string;
}

/** 知見メモを持つIssue1件。 */
export interface KnowledgeIssueNode {
  repo: string;
  number: number;
  title: string;
  url: string;
  /** `OPEN` / `CLOSED`。判定の対象は実装がマージ済みのものだけなので、目安として持つ。 */
  state: string;
  comments: KnowledgeCommentNode[];
}

/** 取ってきたものを整形せずに束ねたもの。`GitHubDevRaw` と同じ考え方。 */
export interface GitHubKnowledgeRaw {
  repoUrl: string | null;
  branch: string | null;
  directories: KnowledgeDirectoryRaw[];
  issues: KnowledgeIssueNode[];
  /** 検索がヒットした総数（Pull Requestや本文一致を含む粗い数）。 */
  issueCount: number;
  /** ページ数の上限に達し、全部は読めていない。 */
  truncated: boolean;
  rateLimit: GitHubRateLimit | null;
  failures: GitHubSourceFailure[];
}

interface GraphQlBody<T> {
  data?: T | null;
  errors?: unknown;
}

/** 1回ぶんの取得結果。**`data` の型を明示するために名前を付けてある**（後述）。 */
interface FetchResult<T> {
  data: T | null;
  failure: GitHubSourceFailure | null;
}

/**
 * GraphQLの `errors` を、外へ出してよい粒度まで丸める。
 *
 * **`message` はそのまま載せない**（権限エラーで内部の構成を含むことがある）。種別だけを残す。
 * `index.ts` の `describeGraphQlErrors` と同じ考え方だが、あちらはリポジトリ名の割り出しまで
 * するのに対し、ここは対象が1つなので種別だけで足りる。
 */
function firstErrorType(errors: unknown): string | null {
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const record = (errors[0] ?? {}) as { type?: unknown };
  return typeof record.type === "string" ? record.type : "ERROR";
}

/**
 * GraphQLを1回叩く。**失敗しても例外にせず、呼び出し側が部分成功を組み立てられる形で返す。**
 * 共有知識とIssue検索は独立していて、片方が落ちてももう片方は出せるため。
 */
async function post<T>(
  config: GitHubConfig,
  query: string,
  variables: Record<string, unknown>,
): Promise<FetchResult<T>> {
  try {
    const res = await fetch(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
        accept: "application/json",
        // GitHubはUser-Agentが無いリクエストを拒否する。
        "user-agent": "aide",
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw res;
    const body = (await res.json()) as GraphQlBody<T>;
    // **HTTP 200 でも `errors` が返る。** `data` が部分的に埋まることもあるので、
    // データは捨てずに理由だけ添える（判断は呼び出し側）。
    const type = firstErrorType(body.errors);
    return {
      data: body.data ?? null,
      failure: type ? { source: "", reason: `GraphQL ${type}` } : null,
    };
  } catch (cause) {
    // 理由は外へ出してよい粒度まで丸めてある（HTTPステータスと例外名まで）。
    // どこの失敗かは呼び出し側が知っているので、`source` は呼び出し側で埋める。
    return { data: null, failure: { source: "", reason: describeFailure(cause, TIMEOUT_MS) } };
  }
}

interface DocsEntry {
  name: string;
  type: string;
  object?: { byteSize?: number; isTruncated?: boolean; text?: string | null } | null;
}

interface DocsData {
  rateLimit?: GitHubRateLimit | null;
  repository?:
    | ({ url?: string; defaultBranchRef?: { name?: string } | null } & Record<
        string,
        unknown
      >)
    | null;
}

interface MemoData {
  rateLimit?: GitHubRateLimit | null;
  search?: {
    issueCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: (
      | {
          number?: number;
          title?: string;
          url?: string;
          state?: string;
          repository?: { nameWithOwner?: string } | null;
          comments?: { nodes: KnowledgeCommentNode[] } | null;
        }
      | null
      | Record<string, never>
    )[];
  } | null;
}

/** 共有知識リポジトリのファイルを取る。 */
async function fetchSharedFiles(
  config: GitHubConfig,
): Promise<{
  repoUrl: string | null;
  branch: string | null;
  directories: KnowledgeDirectoryRaw[];
  rateLimit: GitHubRateLimit | null;
  failures: GitHubSourceFailure[];
}> {
  const { data, failure } = await post<DocsData>(config, DOCS_QUERY, {
    org: config.org,
    repo: DOCS_REPO,
  });

  if (!data?.repository) {
    // **「トークンが無い」と「トークンはあるが読めない」を混ぜない。** ここへ来るのは後者で、
    // fine-grained PAT の対象リポジトリに `docs` が入っていないと NOT_FOUND になる
    // （権限不足は存在しないリポジトリと同じ応答になる、というGitHubの仕様）。
    const reason = failure?.reason ?? "応答にリポジトリが含まれていなかった";
    const hint = reason.includes("NOT_FOUND")
      ? "。トークンの対象リポジトリに含まれていない可能性があります"
      : "";
    return {
      repoUrl: null,
      branch: null,
      directories: [],
      rateLimit: data?.rateLimit ?? null,
      failures: [{ source: `${config.org}/${DOCS_REPO}`, reason: `${reason}${hint}` }],
    };
  }

  const repository = data.repository;
  const directories: KnowledgeDirectoryRaw[] = [];
  for (const dir of SHARED_DIRECTORIES) {
    const node = repository[dir.alias] as { entries?: DocsEntry[] } | null | undefined;
    // ディレクトリごと存在しないことはありうる（templates を消した等）。失敗にはしない。
    if (!node?.entries) continue;

    const files: KnowledgeBlob[] = [];
    for (const entry of node.entries) {
      // サブディレクトリ（`templates/deploy/`）とバイナリは本文が取れないので一覧に出さない。
      if (entry.type !== "blob") continue;
      const text = entry.object?.text;
      if (typeof text !== "string") continue;
      files.push({
        path: `${dir.path}/${entry.name}`,
        text,
        truncated: entry.object?.isTruncated === true,
      });
    }
    directories.push({ path: dir.path, files });
  }

  return {
    repoUrl: repository.url ?? null,
    branch: repository.defaultBranchRef?.name ?? null,
    directories,
    rateLimit: data.rateLimit ?? null,
    // 一部だけ落ちた場合（あるディレクトリだけ読めない等）も握りつぶさない。
    failures: failure ? [{ source: `${config.org}/${DOCS_REPO}`, reason: failure.reason }] : [],
  };
}

/** フリート全体の知見メモを取る。ページ上限に達したら `truncated` を立てる。 */
async function fetchMemoIssues(
  config: GitHubConfig,
): Promise<{
  issues: KnowledgeIssueNode[];
  issueCount: number;
  truncated: boolean;
  rateLimit: GitHubRateLimit | null;
  failures: GitHubSourceFailure[];
}> {
  const issues: KnowledgeIssueNode[] = [];
  const failures: GitHubSourceFailure[] = [];
  let issueCount = 0;
  let truncated = false;
  let rateLimit: GitHubRateLimit | null = null;
  let after: string | null = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    // **型注釈を省かないこと。** 次ページの `after` をこの結果から取るため、注釈が無いと
    // 「自分自身の初期化子から参照されている」として型推論が回らなくなる（TS7022）。
    const page: FetchResult<MemoData> = await post<MemoData>(config, MEMO_QUERY, {
      // `promote-knowledge.yml` と同じ検索語。並びは新しい順で、上限に当たったときに
      // 切り落とされるのが古いものになるようにしている。
      q: `org:${config.org} "${MEMO_SEARCH_TERM}" sort:updated-desc`,
      issues: ISSUES_PER_PAGE,
      comments: COMMENTS_PER_ISSUE,
      after,
    });
    const data = page.data;
    const failure = page.failure;
    if (!data?.search) {
      // 1ページも取れなかったときだけ失敗にする。途中で落ちた場合は取れたぶんを返す。
      if (issues.length === 0) {
        return {
          issues: [],
          issueCount: 0,
          truncated: false,
          rateLimit: data?.rateLimit ?? null,
          failures: [
            { source: "search", reason: failure?.reason ?? "知見メモの検索に失敗した" },
          ],
        };
      }
      truncated = true;
      break;
    }

    rateLimit = data.rateLimit ?? rateLimit;
    issueCount = data.search.issueCount;
    for (const node of data.search.nodes) {
      // 検索はPull Requestも返す。Issue以外は `number` すら無い形で届く。
      if (!node || typeof node !== "object") continue;
      const issue = node as Exclude<MemoData["search"], null | undefined>["nodes"][number] & {
        number?: number;
      };
      if (typeof issue.number !== "number") continue;
      issues.push({
        repo: issue.repository?.nameWithOwner ?? `${config.org}/?`,
        number: issue.number,
        title: issue.title ?? "",
        url: issue.url ?? "",
        state: issue.state ?? "",
        comments: issue.comments?.nodes ?? [],
      });
    }

    if (failure) failures.push({ source: "search", reason: failure.reason });
    if (!data.search.pageInfo.hasNextPage) {
      return { issues, issueCount, truncated, rateLimit, failures };
    }
    after = data.search.pageInfo.endCursor;
  }

  // ループを抜けた＝上限に達した。全部は読めていない。
  return { issues, issueCount, truncated: true, rateLimit, failures };
}

/**
 * 共有知識と知見メモをまとめて取る。整形は行わない。
 *
 * **2本は並行に投げる。** 材料に依存関係が無く、順に投げると実測で1.7秒ぶん待ち時間が増える
 * （ファイルの取得が1.7秒、Issue検索が2ページで7秒前後）。どちらも失敗を例外にしないので、
 * 片方が落ちてももう片方は返る。
 */
export async function fetchKnowledge(config: GitHubConfig): Promise<GitHubKnowledgeRaw> {
  const [shared, memos] = await Promise.all([fetchSharedFiles(config), fetchMemoIssues(config)]);

  return {
    repoUrl: shared.repoUrl,
    branch: shared.branch,
    directories: shared.directories,
    issues: memos.issues,
    issueCount: memos.issueCount,
    truncated: memos.truncated,
    // 残ポイントは後に取ったほうが新しい。
    rateLimit: memos.rateLimit ?? shared.rateLimit,
    failures: [...shared.failures, ...memos.failures],
  };
}
