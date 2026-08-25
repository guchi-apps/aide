import type { GitHubKnowledgeRaw, KnowledgeDirectoryRaw } from "../connectors/github/knowledge.ts";
import { PROMOTION_DIRECTORY } from "../connectors/github/knowledge.ts";
import type { GitHubRateLimit, GitHubSourceFailure } from "../connectors/github/types.ts";

/**
 * 共通知識の横断ビュー。
 *
 * 「いま共有知識に何が入っているか」と「知見の候補がどう判定されたか」を1つに畳む。
 * 材料は2つある。
 *
 * - **採用された知見** — `guchi-apps/docs` の `knowledge/` にある Markdown の `##` 見出し。
 *   1見出し＝1知見という書式は共有知識側のルールで、`knowledge/README.md` が正本
 * - **判定の記録** — 各リポジトリのIssueに残る知見メモ（`<!-- knowledge-candidate -->`）と、
 *   格上げ判定エージェントの結果コメント（`<!-- knowledge-promotion:judged -->`）
 *
 * **書式は実際には揃っていない。** 知見メモは `###` の見出し・`**太字**`・地の文が混在し、
 * マーカーの位置もコメントの先頭だったり末尾だったりする（181件を実際に読んで確認した）。
 * したがって解析は best-effort に振り、取れなかったものは落とさず本文の冒頭を見出しとして出す。
 * **落とすと「メモを書いたのに一覧に出ない」という最悪の形になる**ため、精度より取りこぼしの
 * 無さを優先している。
 *
 * ここは純粋関数だけを持ち、取得は `src/core/connectors/github/knowledge.ts`、
 * 見せ方は `src/web/knowledge.ts` が持つ。
 */

/** 知見メモのマーカー。`promote-knowledge.yml` が集めるときの目印と同じ。 */
export const CANDIDATE_MARKER = "<!-- knowledge-candidate -->";

/** 判定済みのマーカー。これが付いたコメントが1つでもあれば判定は終わっている。 */
export const JUDGED_MARKER = "<!-- knowledge-promotion:judged -->";

export type PromotionVerdict = "approved" | "rejected" | "pending";

/** 共有知識の1知見（Markdownの `##` 見出し1つ）。 */
export interface KnowledgeSectionView {
  /** 見出し。Markdownの記法（`**` や backtick）が残ったまま。整形は表示側で行う。 */
  title: string;
  /** `- **確認日**: 2026-08-09` から取った日付。書かれていなければ null。 */
  confirmedAt: string | null;
  /** `- **出典リポジトリ**: guchi-apps/issue-deck#106`。書かれていなければ null。 */
  source: string | null;
}

export interface KnowledgeFileView {
  /** リポジトリのルートからの相対パス。 */
  path: string;
  name: string;
  /** 先頭の `#` 見出し。無ければファイル名。 */
  title: string;
  sections: KnowledgeSectionView[];
  /** GitHubが本文を切り詰めた場合。件数が実際より少なく出ている印。 */
  truncated: boolean;
  /** 索引（`README.md`）。知見は持たないので件数から外す。 */
  isIndex: boolean;
}

export interface KnowledgeDirectoryView {
  path: string;
  files: KnowledgeFileView[];
  /** 索引を除いた知見の数。 */
  sectionCount: number;
}

/** 知見メモの中の1知見。 */
export interface MemoItemView {
  /** 抽出できた見出し。取れなければ本文の冒頭。 */
  heading: string;
  confirmedAt: string | null;
}

/** 判定コメントから読み取った1件ぶんの結果。 */
export interface VerdictNoteView {
  approved: boolean;
  /** 判定コメントに書かれた知見の見出し。 */
  heading: string;
  /** 反映先（`knowledge/github-actions.md`）。却下なら null。 */
  target: string | null;
  reason: string | null;
}

/** 一覧の1行。知見メモ1件＝1行で、判定が付いていればその結果を持つ。 */
export interface MemoEntryView {
  /** `guchi-apps/issue-deck`。 */
  repo: string;
  /** `issue-deck`。表示用に Organization を落としたもの。 */
  shortRepo: string;
  number: number;
  title: string;
  url: string;
  /** `OPEN` / `CLOSED`。判定の対象は実装がマージ済みのものだけなので目安として持つ。 */
  state: string;
  /** 最初の知見メモが投稿された時刻（ISO8601）。 */
  postedAt: string;
  items: MemoItemView[];
  verdict: PromotionVerdict;
  notes: VerdictNoteView[];
  judgedAt: string | null;
  /** 未判定のまま経った日数。判定済みなら null。 */
  pendingDays: number | null;
}

/** リポジトリ別の内訳。 */
export interface MemoSourceView {
  repo: string;
  shortRepo: string;
  memos: number;
  items: number;
  pending: number;
}

export interface KnowledgeView {
  checkedAt: string;
  /** GitHubのトークンが設定されているか。false ならこのビューは空になる。 */
  configured: boolean;
  repoUrl: string | null;
  branch: string | null;
  /** 格上げ判定の反映先（`knowledge/`）。 */
  adopted: KnowledgeDirectoryView | null;
  /** それ以外の共有知識（人が直接書く場所）。 */
  others: KnowledgeDirectoryView[];
  memos: MemoEntryView[];
  counts: {
    /** 共有知識に入っている知見の数。 */
    adopted: number;
    /** 知見メモの数（Issue単位）。 */
    memos: number;
    /** 知見メモの中の知見の数。 */
    items: number;
    approved: number;
    rejected: number;
    pending: number;
  };
  sources: MemoSourceView[];
  /** 最も古い未判定メモの投稿時刻。 */
  oldestPendingAt: string | null;
  /** 最も古い未判定メモが滞留している日数。 */
  stalledDays: number | null;
  /** 検索結果を全部は読めていない。 */
  truncated: boolean;
  rateLimit: GitHubRateLimit | null;
  failures: GitHubSourceFailure[];
}

// ---- Markdown の解析 ----

/** コードフェンスの開始・終了。囲みの中の `##` を見出しと数えないために要る。 */
const FENCE = /^(`{3,}|~{3,})/;

/**
 * `- **確認日**: 2026-08-09` のような行から値を取る。
 *
 * 太字の有無・全角コロン・行頭の空白は書き手によって揺れるので、どれも通す。
 */
function fieldValue(line: string, label: string): string | null {
  const pattern = new RegExp(`^\\s*[-*]\\s*\\*{0,2}${label}\\*{0,2}\\s*[:：]\\s*(.+)$`);
  const matched = pattern.exec(line);
  if (!matched) return null;
  return matched[1]!.replace(/[`*]/g, "").replace(/[。.]\s*$/, "").trim() || null;
}

/** ファイル1つを解析して、見出し（＝知見）の一覧にする。 */
export function parseKnowledgeFile(path: string, text: string, truncated = false): KnowledgeFileView {
  const name = path.split("/").pop() ?? path;
  const sections: KnowledgeSectionView[] = [];
  let title = "";
  let fence: string | null = null;
  let current: KnowledgeSectionView | null = null;

  for (const line of text.split("\n")) {
    const fenceMatch = FENCE.exec(line.trim());
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      // 開いているフェンスは、同じ記号で同じ長さ以上の行でしか閉じない。
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;

    if (!title && line.startsWith("# ")) {
      title = line.slice(2).trim();
      continue;
    }
    if (line.startsWith("## ")) {
      current = { title: line.slice(3).trim(), confirmedAt: null, source: null };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    current.confirmedAt ??= fieldValue(line, "確認日");
    current.source ??= fieldValue(line, "出典リポジトリ") ?? fieldValue(line, "出典");
  }

  return {
    path,
    name,
    title: title || name,
    sections,
    truncated,
    isIndex: name.toLowerCase() === "readme.md",
  };
}

function parseDirectory(raw: KnowledgeDirectoryRaw): KnowledgeDirectoryView {
  const files = raw.files
    .filter((file) => file.path.toLowerCase().endsWith(".md"))
    .map((file) => parseKnowledgeFile(file.path, file.text, file.truncated))
    // 知見の多い順。索引（README）は最後へ回す。
    .sort((a, b) => {
      if (a.isIndex !== b.isIndex) return a.isIndex ? 1 : -1;
      if (a.sections.length !== b.sections.length) return b.sections.length - a.sections.length;
      return a.name.localeCompare(b.name);
    });

  return {
    path: raw.path,
    files,
    sectionCount: files.reduce((sum, file) => sum + (file.isIndex ? 0 : file.sections.length), 0),
  };
}

// ---- 知見メモの解析 ----

/** 見出しではなくラベルとして書かれる語。これだけの行を見出しにしない。 */
const LABEL_ONLY = /^(知見メモ|知見|メモ|補足)$/;

/** 見出しが取れなかったときに本文の冒頭から作る見出しの長さ。 */
const FALLBACK_HEADING_LENGTH = 120;

/** HTMLコメント（不可視マーカー）を落とす。 */
function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * コードフェンスで囲まれた部分を落とす。
 *
 * **この仕組み自体を設計したIssueが誤検出の元になる。** 運用を決めたIssue
 * （guchi-apps/issue-deck#2029・guchi-apps/docs#65）は、書式の説明としてマーカーを
 * 囲みの中に貼っている。そのまま数えると、判定していないIssueが「判定済み」になり、
 * 知見でもないコメント（「実装完了」など）が知見として並ぶ（実データで11件そうなった）。
 */
function stripFencedBlocks(text: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const matched = FENCE.exec(line.trim());
    if (matched) {
      const marker = matched[1]!;
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence === null) kept.push(line);
  }
  return kept.join("\n");
}

/**
 * マーカーが「そのコメント自身のもの」として置かれているか。
 *
 * **行全体がマーカーであることまで見る。** 各テンプレートはマーカーを独立した行に置くのに対し、
 * 設計の説明で言及するときは `` `<!-- ... -->` `` のように地の文へ埋め込まれる。
 * 単なる `includes` では後者まで拾ってしまう。
 */
function hasMarkerLine(body: string, marker: string): boolean {
  return stripFencedBlocks(body)
    .split("\n")
    .some((line) => line.trim() === marker);
}

/**
 * 知見メモ1つぶんの本文から見出しを決める。
 *
 * 実物の書式は3通りある（`###` の見出し・`**太字**` の1行・地の文）。
 * どれでも取れるようにし、**最後は本文の冒頭を切り出して必ず何かを返す**。
 */
function headingOf(chunk: string): string {
  const lines = chunk.split("\n").map((line) => line.trim());
  let fallback = "";

  for (const line of lines) {
    if (!line) continue;
    if (FENCE.test(line)) break;

    const hash = /^#{2,6}\s+(.+)$/.exec(line);
    if (hash) return hash[1]!.trim();

    const bold = /^\*\*(.+?)\*\*[。.]?$/.exec(line);
    if (bold) {
      const inner = bold[1]!.trim();
      if (!LABEL_ONLY.test(inner)) return inner;
      continue;
    }

    if (!fallback) fallback = line.replace(/^[-*]\s*/, "");
  }

  if (!fallback) return "（本文なし）";
  return fallback.length > FALLBACK_HEADING_LENGTH
    ? `${fallback.slice(0, FALLBACK_HEADING_LENGTH)}…`
    : fallback;
}

/**
 * 知見メモのコメント本文を、知見ごとに切り分ける。
 *
 * **マーカーの位置で切る。** 1つのコメントに知見を複数書くときは知見ごとにマーカーを置く
 * 書き方が実際にあり（guchi-apps/issue-deck#2246 は3件）、逆にマーカーが末尾に1つだけの
 * コメントもある。マーカーで分割すると、どちらも同じ扱いで切り出せる。
 */
export function parseMemoComment(body: string): MemoItemView[] {
  // 囲みの中のマーカーでは切らない（書式の例としてマーカーを貼るメモが実在する）。
  const chunks: string[][] = [[]];
  let fence: string | null = null;
  for (const line of body.split("\n")) {
    const matched = FENCE.exec(line.trim());
    if (matched) {
      const marker = matched[1]!;
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
    } else if (fence === null && line.trim() === CANDIDATE_MARKER) {
      chunks.push([]);
      continue;
    }
    chunks[chunks.length - 1]!.push(line);
  }

  const items: MemoItemView[] = [];
  for (const lines of chunks) {
    // 見出しも確認日も囲みの外にしか書かれない。中を見ると例文を拾う。
    const chunk = stripComments(stripFencedBlocks(lines.join("\n"))).trim();
    if (!chunk) continue;

    let confirmedAt: string | null = null;
    for (const line of chunk.split("\n")) {
      confirmedAt ??= fieldValue(line, "確認日");
    }
    items.push({ heading: headingOf(chunk), confirmedAt });
  }
  return items;
}

/** 判定コメントの1行目。`- ✅ 承認: <見出し> → \`knowledge/x.md\`（新設）` の形。 */
const VERDICT_LINE = /^\s*[-*]\s*(?:✅|❌|:white_check_mark:|:x:)?\s*(承認|却下)\s*[:：]\s*(.+)$/;
const REASON_LINE = /^\s*[-*]\s*\*{0,2}理由\*{0,2}\s*[:：]\s*(.+)$/;
/** 反映先のパス。`knowledge/` 配下だけが対象。 */
const TARGET_PATH = /knowledge\/[\w.-]+\.md/;

/**
 * 判定コメントの本文から、知見ごとの承認・却下と理由を取る。
 *
 * 書式は `promote-knowledge.yml` のプロンプトが指定している。**指定どおりに書かれていない
 * 場合でも、行が1つも取れなかったこと自体は呼び出し側で分かる**ようにしてある
 * （空配列が返り、判定は「未判定」ではなく「判定済み・内訳不明」として扱う）。
 */
export function parseVerdictComment(body: string): VerdictNoteView[] {
  const notes: VerdictNoteView[] = [];
  for (const line of stripComments(stripFencedBlocks(body)).split("\n")) {
    const verdict = VERDICT_LINE.exec(line);
    if (verdict) {
      const rest = verdict[2]!.trim();
      const [headingPart] = rest.split("→");
      notes.push({
        approved: verdict[1] === "承認",
        heading: (headingPart ?? rest).replace(/[`*]/g, "").trim(),
        target: TARGET_PATH.exec(rest)?.[0] ?? null,
        reason: null,
      });
      continue;
    }
    const reason = REASON_LINE.exec(line);
    // 理由は直前の判定行にぶら下がる。判定行より先に出てきた理由は捨てる。
    if (reason && notes.length > 0) notes[notes.length - 1]!.reason = reason[1]!.trim();
  }
  return notes;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function daysBetween(from: string, to: Date): number {
  const started = Date.parse(from);
  if (Number.isNaN(started)) return 0;
  return Math.max(0, Math.floor((to.getTime() - started) / DAY_MS));
}

/**
 * 知見メモを持つIssue1件を、一覧の1行にする。
 *
 * 知見メモが1件も無ければ null。**GitHubのIssue検索は本文もコメントも対象にする**ため、
 * このワークフローを設計したIssueのように「本文にマーカーの文字列が出てくるだけ」のものが
 * 混ざる。`promote-knowledge.yml` と同じく、コメント側にマーカーがあるかで判定する。
 * **さらに、囲みの中と地の文への言及も除く**（`hasMarkerLine`）。
 */
function buildEntry(
  issue: GitHubKnowledgeRaw["issues"][number],
  now: Date,
): MemoEntryView | null {
  const memoComments = issue.comments.filter((comment) => hasMarkerLine(comment.body, CANDIDATE_MARKER));
  if (memoComments.length === 0) return null;

  const items = memoComments.flatMap((comment) => parseMemoComment(comment.body));
  if (items.length === 0) return null;

  const postedAt = memoComments.reduce(
    (oldest, comment) => (comment.createdAt < oldest ? comment.createdAt : oldest),
    memoComments[0]!.createdAt,
  );

  // 判定は後から投稿されるので、複数あれば新しいほうを採る。
  const judged = issue.comments.filter((comment) => hasMarkerLine(comment.body, JUDGED_MARKER)).at(-1);
  const notes = judged ? parseVerdictComment(judged.body) : [];
  const verdict: PromotionVerdict = judged
    ? notes.some((note) => note.approved)
      ? "approved"
      : "rejected"
    : "pending";

  return {
    repo: issue.repo,
    shortRepo: issue.repo.split("/").pop() ?? issue.repo,
    number: issue.number,
    title: issue.title,
    url: issue.url,
    state: issue.state,
    postedAt,
    items,
    verdict,
    notes,
    judgedAt: judged?.createdAt ?? null,
    pendingDays: judged ? null : daysBetween(postedAt, now),
  };
}

function buildSources(memos: MemoEntryView[]): MemoSourceView[] {
  const byRepo = new Map<string, MemoSourceView>();
  for (const memo of memos) {
    const found = byRepo.get(memo.repo) ?? {
      repo: memo.repo,
      shortRepo: memo.shortRepo,
      memos: 0,
      items: 0,
      pending: 0,
    };
    found.memos += 1;
    found.items += memo.items.length;
    if (memo.verdict === "pending") found.pending += memo.items.length;
    byRepo.set(memo.repo, found);
  }
  return [...byRepo.values()].sort((a, b) => b.items - a.items || a.repo.localeCompare(b.repo));
}

/** トークンが無い環境のための空のビュー。画面は「未設定」と出すだけになる。 */
export function emptyKnowledgeView(now: Date = new Date()): KnowledgeView {
  return {
    checkedAt: now.toISOString(),
    configured: false,
    repoUrl: null,
    branch: null,
    adopted: null,
    others: [],
    memos: [],
    counts: { adopted: 0, memos: 0, items: 0, approved: 0, rejected: 0, pending: 0 },
    sources: [],
    oldestPendingAt: null,
    stalledDays: null,
    truncated: false,
    rateLimit: null,
    failures: [],
  };
}

/** 取ってきたものを画面に出せる形へ畳む。**純粋関数。テストはここに当てる。** */
export function buildKnowledgeView(raw: GitHubKnowledgeRaw, now: Date = new Date()): KnowledgeView {
  const directories = raw.directories.map(parseDirectory);
  const adopted = directories.find((dir) => dir.path === PROMOTION_DIRECTORY) ?? null;
  const others = directories.filter((dir) => dir.path !== PROMOTION_DIRECTORY);

  const memos = raw.issues
    .map((issue) => buildEntry(issue, now))
    .filter((entry): entry is MemoEntryView => entry !== null)
    // 新しい順。上限で切り落とされるのが古いものになる並びと揃える。
    .sort((a, b) => b.postedAt.localeCompare(a.postedAt));

  const counts = {
    adopted: adopted?.sectionCount ?? 0,
    memos: memos.length,
    items: memos.reduce((sum, memo) => sum + memo.items.length, 0),
    approved: 0,
    rejected: 0,
    pending: 0,
  };
  for (const memo of memos) {
    // 内訳は知見の数で数える。Issue単位で数えると、3件書いたメモが1件に見える。
    counts[memo.verdict] += memo.items.length;
  }

  const pending = memos.filter((memo) => memo.verdict === "pending");
  const oldestPendingAt =
    pending.length > 0
      ? pending.reduce((oldest, memo) => (memo.postedAt < oldest ? memo.postedAt : oldest), pending[0]!.postedAt)
      : null;

  return {
    checkedAt: now.toISOString(),
    configured: true,
    repoUrl: raw.repoUrl,
    branch: raw.branch,
    adopted,
    others,
    memos,
    counts,
    sources: buildSources(memos),
    oldestPendingAt,
    stalledDays: oldestPendingAt ? daysBetween(oldestPendingAt, now) : null,
    truncated: raw.truncated,
    rateLimit: raw.rateLimit,
    failures: raw.failures,
  };
}
