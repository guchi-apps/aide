import { describeFailure, type GitHubConfig } from "./index.ts";

/**
 * GitHubへの書き込み。**Issueの新規作成だけ**を持つ（aide#50）。
 *
 * 取得側（`index.ts`）がGraphQL v4なのに対し、こちらはREST v3を使う。
 * 起票のmutation（`createIssue`）はラベルを**ID**で渡す必要があり、名前で渡せるRESTより
 * 往復が増える。1リクエストで済む取得側と違い、ここは元から複数回叩くため利点が無い。
 *
 * **編集・close・コメント・PR操作は持たない。** それらはissue-deck（GitHub App）の仕事で、
 * AIDEに置いても往復が増えるだけになる。ここにあるのは「Claudeアプリから起票する」という
 * 他のどこからも塞がっている経路を開けるためだけの最小の口。
 */

const REST_ROOT = "https://api.github.com";

/**
 * 制限時間。
 * 取得側（10秒・26リポジトリぶんのコミットグラフを辿る）と違い、こちらは
 * ラベル一覧の取得と起票の2回だけなので短くてよい。MCPの同期リクエストの中で叩くため、
 * GitHubが遅くてもツールが固まらないよう切る。
 */
const TIMEOUT_MS = 5_000;

/** 起票時に既定で付けるラベル。人が着手要否を判断するまで実装フローへ自動で乗せないため。 */
export const DEFAULT_LABELS = ["70.confirm"];

/** 本文の上限。GitHubのAPI上限（65536）よりかなり手前で切る。口述の書き起こしがこれを超えることはない。 */
const MAX_BODY_LENGTH = 20_000;

/** タイトルの上限。GitHubは256文字を超えると422を返す。 */
const MAX_TITLE_LENGTH = 200;

/**
 * 本文の末尾に足す出所の記録。
 *
 * Claudeアプリからの起票は口述をそのまま起こしたもので、人が自分で書いたIssueとは
 * 精度が違う。後から見た人が区別できるよう、本文自体に残す
 * （ラベルはリポジトリによって有無が違うため、ラベルだけに頼らない）。
 */
export const FOOTNOTE =
  "---\n\n" +
  "このIssueはClaudeアプリからAIDE（`aide_create_issue`）経由で起票されました。" +
  "口述の内容をそのまま起こしているため、着手する前に内容の確認が要ります。\n\n" +
  "<!-- aide:created-via-mcp -->";

export interface CreateIssueInput {
  /** リポジトリ名。owner は含めない。 */
  repo: string;
  title: string;
  body?: string | undefined;
  /** 省略時は DEFAULT_LABELS。対象リポジトリに実在するものだけが付く。 */
  labels?: string[] | undefined;
}

export interface CreateIssueOutcome {
  ok: boolean;
  /** 失敗の理由。外へ出してよい粒度まで丸めたもの。 */
  reason?: string;
  url?: string;
  number?: number;
  repo?: string;
  /** 実際に付いたラベル。 */
  labels?: string[];
  /** 対象リポジトリに存在せず、落としたラベル。 */
  droppedLabels?: string[];
}

/**
 * リポジトリ名を検査する。
 *
 * `owner/repo` を渡されたときに素通しすると、`AIDE_GITHUB_ORG` とは別のownerの下へ
 * 起票しようとして404になるだけで、何が悪いのか呼び出し側に伝わらない。
 * GitHubのリポジトリ名に使える文字は英数字と `.`・`-`・`_` に限られる。
 */
export function normalizeRepo(raw: string): { repo: string } | { error: string } {
  const repo = raw.trim();
  if (!repo) return { error: "repo が空です" };
  if (repo.includes("/")) {
    return { error: `repo には owner を含めず、リポジトリ名だけを指定してください（例: ${repo.split("/").at(-1)}）` };
  }
  if (!/^[A-Za-z0-9._-]+$/.test(repo)) return { error: "repo にリポジトリ名として使えない文字が含まれています" };
  return { repo };
}

/**
 * 要求されたラベルのうち、対象リポジトリに実在するものだけを選ぶ。
 *
 * **GitHubのIssue作成APIは、存在しないラベル名を渡すと勝手にラベルを新規作成する。**
 * ラベルは issue-deck 側から人の判断で揃える運用（issue-deck `scripts/check-label-diff.sh`）
 * なので、ここで増やしてはいけない。実在しないものは黙って落とす。
 *
 * GitHubのラベル名は大文字小文字を区別しないため、照合も区別しない。
 */
export function selectExistingLabels(
  requested: readonly string[],
  existing: readonly string[],
): { applied: string[]; dropped: string[] } {
  const known = new Map(existing.map((name) => [name.toLowerCase(), name]));
  const applied: string[] = [];
  const dropped: string[] = [];

  for (const name of requested) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    const match = known.get(trimmed.toLowerCase());
    if (match === undefined) {
      dropped.push(trimmed);
    } else if (!applied.includes(match)) {
      applied.push(match);
    }
  }

  return { applied, dropped };
}

/** 本文を組み立てる。空でも脚注だけは必ず載せる。 */
export function buildBody(body: string | undefined): string {
  const trimmed = (body ?? "").trim().slice(0, MAX_BODY_LENGTH);
  return trimmed ? `${trimmed}\n\n${FOOTNOTE}` : FOOTNOTE;
}

/**
 * 起票の暴発ガード。
 *
 * ClaudeはMCPツールを会話の流れで自発的に呼ぶため、「あとでIssueにしておいて」の一言で
 * 似たIssueが何件も立ちうる。既存のエージェント運用にも「1回あたり目安3件まで」という
 * ルールがある（issue-deck `docs/multi-agent/labels.md`）ので、同じ上限を機械的に効かせる。
 *
 * 状態はプロセス内メモリに置く。再起動で消えるが、`src/auth/ratelimit.ts` と同じ判断で、
 * 数件の起票のためにディスクI/Oを増やす方が割に合わない。
 */
export class CreationGuard {
  readonly #windowMs: number;
  readonly #max: number;
  readonly #accepted: number[] = [];
  #lastKey: string | null = null;

  constructor(windowMs: number, max: number) {
    this.#windowMs = windowMs;
    this.#max = max;
  }

  /**
   * 起票してよければ null、断るなら理由を返す。
   * 通した時点で記録するため、呼ぶのは実際に起票する直前に1回だけ。
   */
  admit(key: string, now: number): string | null {
    if (key === this.#lastKey) {
      return "直前に同じリポジトリ・同じタイトルで起票しています。重複の可能性があるため作成しませんでした。";
    }

    while (this.#accepted.length > 0 && now - this.#accepted[0]! >= this.#windowMs) {
      this.#accepted.shift();
    }
    if (this.#accepted.length >= this.#max) {
      const minutes = Math.ceil(this.#windowMs / 60_000);
      return `${minutes}分あたり${this.#max}件の上限に達しています。まとめて起票せず、内容を整理してから改めて依頼してください。`;
    }

    this.#accepted.push(now);
    this.#lastKey = key;
    return null;
  }
}

/** 既定のガード。10分あたり3件。 */
const guard = new CreationGuard(10 * 60 * 1000, 3);

/** 認証情報が漏れない形で叩く。`res.ok` でなければ Response 自体を投げる（describeFailure が拾う）。 */
async function request(config: GitHubConfig, path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${REST_ROOT}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${config.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      // GitHubはUser-Agentが無いリクエストを拒否する。
      "user-agent": "aide",
      ...(init?.body ? { "content-type": "application/json" } : {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw res;
  return res;
}

/**
 * 対象リポジトリのラベル名を引く。
 *
 * 取れなかった場合は空配列を返して**起票そのものは続ける**。ラベルは補助的な情報で、
 * ラベル一覧が引けないことを理由に起票を落とすと、Claudeアプリから見て何もできなくなる。
 */
async function fetchLabelNames(config: GitHubConfig, repo: string): Promise<string[]> {
  try {
    const res = await request(config, `/repos/${config.org}/${repo}/labels?per_page=100`);
    const labels = (await res.json()) as { name?: unknown }[];
    return labels.map((label) => label.name).filter((name): name is string => typeof name === "string");
  } catch {
    return [];
  }
}

/** 書き込みで起きやすい失敗を、対処の分かる文言に置き換える。それ以外は取得側と同じ丸め方に任せる。 */
function describeWriteFailure(cause: unknown, org: string, repo: string): string {
  if (cause instanceof Response) {
    if (cause.status === 404) {
      return `${org}/${repo} が見つかりません（リポジトリ名の誤りか、トークンの対象に含まれていません）`;
    }
    if (cause.status === 403) {
      return "HTTP 403（AIDE_GITHUB_ISSUE_TOKEN に Issues: Read and write が無いか、レート制限）";
    }
    if (cause.status === 410) return "このリポジトリではIssueが無効になっています";
    if (cause.status === 422) return "GitHubが内容を受け付けませんでした（タイトルが長すぎる等）";
  }
  return describeFailure(cause, TIMEOUT_MS);
}

/**
 * Issueを起票する。
 *
 * 起票そのものは1リクエストだが、その前にラベル一覧を引いて実在するものだけに絞る
 * （`selectExistingLabels` の説明のとおり、渡したラベルが勝手に作られるのを避けるため）。
 */
export async function createIssue(
  config: GitHubConfig,
  input: CreateIssueInput,
  now: number = Date.now(),
): Promise<CreateIssueOutcome> {
  const normalized = normalizeRepo(input.repo);
  if ("error" in normalized) return { ok: false, reason: normalized.error };
  const repo = normalized.repo;

  const title = input.title.trim();
  if (!title) return { ok: false, reason: "title が空です" };
  if (title.length > MAX_TITLE_LENGTH) {
    return { ok: false, reason: `title が長すぎます（${MAX_TITLE_LENGTH}文字まで）` };
  }

  const rejected = guard.admit(`${repo} ${title}`, now);
  if (rejected) return { ok: false, reason: rejected };

  const requested = input.labels ?? DEFAULT_LABELS;
  const { applied, dropped } = selectExistingLabels(requested, await fetchLabelNames(config, repo));

  let created: { number?: unknown; html_url?: unknown };
  try {
    const res = await request(config, `/repos/${config.org}/${repo}/issues`, {
      method: "POST",
      body: JSON.stringify({ title, body: buildBody(input.body), labels: applied }),
    });
    created = (await res.json()) as typeof created;
  } catch (cause) {
    return { ok: false, reason: describeWriteFailure(cause, config.org, repo) };
  }

  return {
    ok: true,
    repo: `${config.org}/${repo}`,
    number: typeof created.number === "number" ? created.number : undefined,
    url: typeof created.html_url === "string" ? created.html_url : undefined,
    labels: applied,
    droppedLabels: dropped,
  };
}
