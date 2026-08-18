import { DEV_REPO_QUERY, DEV_STATUS_QUERY, REPOSITORY_FETCH_LIMIT } from "./query.ts";
import type {
  GitHubDevRaw,
  GitHubGraphQlData,
  GitHubRepositoryNode,
  GitHubSourceFailure,
} from "./types.ts";

/**
 * GitHub コネクタ。
 *
 * ClaudeアプリにはGitHubの公式コネクタが無いため、GitHubは README「Core と MCP層の境界」で
 * いう**公式MCPが無いもの＝MCP層に出してよい対象**にあたる（Zaimと同じ位置づけ）。
 *
 * ただし **AIDEをGitHub取得の唯一の口にはしない。** issue-deck（GitHub Appでの書き込み）・
 * ops-dashboard（Actions残枠）・portfolio（公開用の取り込み）の3実装はそのまま残し、
 * AIDEが持つのは**横断ビューと、他のどこからも塞がっている経路**だけにする。
 *
 * **書き込みはIssueの新規作成1本に限る**（`write.ts`。aide#50）。ClaudeアプリからIssueを
 * 起票する経路が他に無いため（issue-deckはMCPサーバーを持たず、`POST /api/issues` は
 * Cookie認証）AIDEに置くが、編集・close・コメントは持たない。それらはissue-deckの仕事で、
 * AIDE経由にすると往復が増えるだけになる。
 * **資格情報も分ける。** このファイルが読む `AIDE_GITHUB_TOKEN` はRead-onlyのままで、
 * 書き込みは `AIDE_GITHUB_ISSUE_TOKEN` を使う（`src/api/secret.ts` の
 * 「読み取りと書き込みでシークレットを分ける」と同じ考え方）。
 *
 * REST ではなく **GraphQL v4** を使う。対象が26リポジトリあり、RESTだと同じ内容に
 * 約80リクエストかかる（リポジトリごとに compare・releases・commits・issues）。
 * GraphQLなら1リクエスト・実測2ポイント（上限は1時間5000ポイント）で済み、Issue #32 の
 * 「注意点」にあるレート制限の懸念が現実にならない。`fetch` だけで叩けるので実行時依存も増えない。
 */

const GRAPHQL_ENDPOINT = "https://api.github.com/graphql";

/** 既定の対象Organization。 */
const DEFAULT_ORG = "guchi-apps";

/**
 * 制限時間。
 * MCPの同期リクエストの中で叩くため、GitHubが遅くてもツールが固まらないよう切る。
 *
 * ops-dashboard（localhost・3秒）より大幅に長い。**26リポジトリぶんの俯瞰は実測で3〜4秒
 * かかる**（うち `compare` だけで約1.4秒。GitHub側がリポジトリごとにコミットグラフを
 * 辿るため、これ以上は縮まない）。5秒にしていたときは実際にタイムアウトした。
 * 詳細モード（1リポジトリ）は約1秒で返る。
 */
const TIMEOUT_MS = 10_000;

export interface GitHubConfig {
  token: string;
  org: string;
}

/**
 * 設定を読む。トークンが無ければ null（＝GitHubへ一切アクセスしない）。
 *
 * **トークンは認証情報として扱う。** 戻り値をログ・レスポンスへ出さないこと。
 */
export function readGitHubConfig(): GitHubConfig | null {
  const token = process.env["AIDE_GITHUB_TOKEN"];
  if (!token) return null;

  return { token, org: process.env["AIDE_GITHUB_ORG"] ?? DEFAULT_ORG };
}

/**
 * 書き込み（Issueの起票）用の設定を読む。トークンが無ければ null（＝起票ツールは動かない）。
 *
 * **読み取り用の `AIDE_GITHUB_TOKEN` へフォールバックしない。** フォールバックすると、
 * Read-onlyのトークンで書き込みを試みて403を返すだけの経路ができ、
 * 「書き込み権限を持たせたか」が設定から読み取れなくなる。
 */
export function readGitHubWriteConfig(): GitHubConfig | null {
  const token = process.env["AIDE_GITHUB_ISSUE_TOKEN"];
  if (!token) return null;

  return { token, org: process.env["AIDE_GITHUB_ORG"] ?? DEFAULT_ORG };
}

/**
 * 失敗の理由を、外へ出してよい粒度まで丸める。
 *
 * 例外の `message` にはURLが載ることがある。HTTPステータスと例外の種別だけに落とす。
 * ops-dashboard コネクタの `describeFailure` と同じ考え方。
 *
 * 制限時間は取得と書き込みで違うため引数で受ける（既定はこのファイルの取得用）。
 */
export function describeFailure(cause: unknown, timeoutMs: number = TIMEOUT_MS): string {
  if (cause instanceof Response) {
    // 401/403 は「トークンが無効・権限不足」で、対処が他の失敗とまったく違うので区別する。
    if (cause.status === 401) return "HTTP 401（トークンが無効）";
    if (cause.status === 403) return "HTTP 403（権限不足かレート制限）";
    return `HTTP ${cause.status}`;
  }
  if (cause instanceof Error) {
    if (cause.name === "TimeoutError") return `${timeoutMs}ms 以内に応答しなかった`;
    if (cause.name === "SyntaxError") return "JSONとして読めない応答が返った";
    return "接続できなかった";
  }
  return "取得に失敗した";
}

/** GraphQLのエラーパスの先頭。リポジトリ一覧の何番目かを指す。 */
const REPOSITORY_PATH_PREFIX = ["organization", "repositories", "nodes"];

/**
 * `main` が無いリポジトリ（`master` 運用など）では `compare` が NOT_FOUND になる。
 * これは**安定した既知の状態であって障害ではない**ので、失敗として数えない
 * （数えると `complete` が恒久的に false になり、本物の失敗が埋もれる）。
 * 該当リポジトリは `compare` が null のまま届き、ビュー側で `releaseFlow: false` になる。
 */
function isMissingReleaseBranch(type: string, path: unknown[]): boolean {
  return type === "NOT_FOUND" && path.at(-1) === "compare";
}

/**
 * GraphQLの `errors` を、外へ出してよい粒度まで丸める。
 *
 * `message` は権限エラーで内部の構成を含むことがあるため**そのまま載せない。**
 * 「どこが取れなかったか」と種別（`type`）だけを残す。
 *
 * パスに含まれるのは配列の添字なので、そのままではどのリポジトリの話か分からない。
 * 取れているノードから名前を引いて置き換える。
 */
function describeGraphQlErrors(
  errors: unknown,
  nodes: (GitHubRepositoryNode | null)[],
): GitHubSourceFailure[] {
  if (!Array.isArray(errors)) return [];

  const failures: GitHubSourceFailure[] = [];
  for (const error of errors as unknown[]) {
    const record = (error ?? {}) as { type?: unknown; path?: unknown };
    const path = Array.isArray(record.path) ? record.path : [];
    const type = typeof record.type === "string" ? record.type : "ERROR";

    if (isMissingReleaseBranch(type, path)) continue;

    const isRepoPath = REPOSITORY_PATH_PREFIX.every((segment, i) => path[i] === segment);
    const name = isRepoPath ? nodes[Number(path[3])]?.name : undefined;
    const source = name
      ? [name, ...path.slice(4)].join(".")
      : path.length > 0
        ? path.join(".")
        : "graphql";

    failures.push({ source, reason: `GraphQL ${type}` });
  }

  return failures;
}

export interface FetchDevStatusOptions {
  /** 1リポジトリあたり取る直近コミット数。 */
  commits: number;
  /** 1リポジトリあたり取るIssue/PRのノード数（件数は深さに関係なく正確に返る）。 */
  issueNodes: number;
  /**
   * 指定するとそのリポジトリ1件だけを引く（詳細モード）。
   * **組織全体を深く掘ると5秒で返ってこない**ため、深く掘るときは必ず対象を絞る。
   */
  repo?: string | undefined;
}

/**
 * 開発状況を取得する。整形は行わない（`src/core/views/dev.ts` の仕事）。
 *
 * **GraphQLは HTTP 200 でも `errors` を返し、`data` が部分的に埋まる**（アクセスできない
 * リポジトリが1件混ざった場合など）。取れたぶんは使い、取れなかったものは `failures` に残す。
 * 全体を失敗にすると「他は取れていた」という情報まで失う。
 */
export async function fetchDevStatus(
  config: GitHubConfig,
  options: FetchDevStatusOptions,
): Promise<GitHubDevRaw> {
  const failures: GitHubSourceFailure[] = [];
  const single = Boolean(options.repo);

  let body: { data?: GitHubGraphQlData | null; errors?: unknown };
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
      body: JSON.stringify({
        query: single ? DEV_REPO_QUERY : DEV_STATUS_QUERY,
        variables: single
          ? {
              org: config.org,
              repo: options.repo,
              commits: options.commits,
              issueNodes: options.issueNodes,
            }
          : {
              org: config.org,
              repos: REPOSITORY_FETCH_LIMIT,
              commits: options.commits,
              issueNodes: options.issueNodes,
            },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // ここで Response 自体を throw する。describeFailure がステータスだけを取り出す。
    if (!res.ok) throw res;
    body = (await res.json()) as typeof body;
  } catch (cause) {
    return { repositories: [], rateLimit: null, failures: [{ source: "github", reason: describeFailure(cause) }] };
  }

  const nodes = single
    ? [body.data?.repository ?? null]
    : (body.data?.organization?.repositories?.nodes ?? []);
  failures.push(...describeGraphQlErrors(body.errors, nodes));

  // アクセス権が無いリポジトリは null で返ってくる。件数だけ拾っても意味が無いので落とす。
  const repositories = nodes.filter((node): node is GitHubRepositoryNode => node !== null);

  // 詳細モードで0件なのは「そんなリポジトリは無い」だけのことが多く、障害ではない。
  // 理由はビュー側が scope に書くので、ここで失敗を立てない。
  if (!single && repositories.length === 0 && failures.length === 0) {
    failures.push({ source: "organization", reason: "リポジトリを1件も取得できなかった" });
  }

  return { repositories, rateLimit: body.data?.rateLimit ?? null, failures };
}
