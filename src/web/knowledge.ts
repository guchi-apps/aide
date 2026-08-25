import type { IncomingMessage, ServerResponse } from "node:http";
import { readGitHubConfig } from "../core/connectors/github/index.ts";
import { fetchKnowledge } from "../core/connectors/github/knowledge.ts";
import {
  buildKnowledgeView,
  emptyKnowledgeView,
  type KnowledgeDirectoryView,
  type KnowledgeFileView,
  type KnowledgeView,
  type MemoEntryView,
  type PromotionVerdict,
} from "../core/views/knowledge.ts";
import { formatJst } from "../worker/notify.ts";
import { card, escapeHtml, pill, renderPage, siteNav, table, type Tone } from "./layout.ts";
import { currentSession, renderLoginPage, type StatusOptions } from "./status.ts";
import type { StatusSession } from "./session.ts";

/**
 * 共通知識ページ（`GET /knowledge`）。
 *
 * `guchi-apps/docs` に何が入っているかと、知見の候補がどう採用・却下されたかを1画面で見る
 * （aide#161）。それまでは、共有知識の中身はリポジトリを開かないと分からず、判定の結果は
 * 出典Issueのコメントに散っていて一覧できなかった。
 *
 * **公開範囲は動作状況ページと同じ。** 中身はprivateリポジトリのファイルとIssueなので、
 * 機能一覧（`/features`）のように無認証では出さず、同じCookieセッションの内側に置く。
 * 判定は `currentSession()`（`src/web/status.ts`）に寄せてあり、この画面で書き直さない。
 *
 * **`/status` と違って、開くとGitHubへ問い合わせる。** あちらは「相手が落ちているだけで
 * 画面が開かなくなる」のを避けるため手元の材料しか読まないが、こちらは取得結果そのものが
 * 中身なので避けようがない。代わりに取得結果を数分キャッシュし、失敗しても取れたぶんは出す。
 */

const TITLE = "AIDE の共通知識";

/**
 * 取得結果を持ち回る時間。
 *
 * 材料が変わるのは、共有知識へのPull Requestがマージされたときと、格上げ判定
 * （`promote-knowledge.yml`。毎日05:00 JST）が走ったときだけで、どちらも日単位でしか動かない。
 * 一方で取得には実測8〜10秒かかるため、開き直すたびに待たせないだけの短い保持で十分効く。
 * **`?refresh=1` を付けると捨てて取り直す**（判定を手で流した直後に確かめられるように）。
 */
const CACHE_MS = 5 * 60 * 1000;

let cached: { view: KnowledgeView; at: number } | null = null;

async function loadView(refresh: boolean): Promise<KnowledgeView> {
  if (!refresh && cached && Date.now() - cached.at < CACHE_MS) return cached.view;

  const config = readGitHubConfig();
  // トークンが無ければGitHubへ一切アクセスしない。画面は「未設定」と出すだけになる。
  if (!config) return emptyKnowledgeView();

  const view = buildKnowledgeView(await fetchKnowledge(config));
  cached = { view, at: Date.now() };
  return view;
}

// ---- 表示 ----

/**
 * Markdownの見出しをそのまま出すと `**` や backtick が見えてしまう。
 * **エスケープしてから**、太字とコードだけを組み立て直す（他の記法は素通し）。
 */
function inlineMarkdown(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<span class="mono">$1</span>')
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
}

/** 日付だけの表示（JST）。一覧の列に並べるので時刻までは出さない。 */
function formatDay(at: string): string {
  const parsed = new Date(at);
  if (Number.isNaN(parsed.getTime())) return "?";
  // sv-SE は "2026-08-25" 形式になる。
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", dateStyle: "short" }).format(parsed);
}

const VERDICT_TONE: Record<PromotionVerdict, Tone> = {
  approved: "ok",
  rejected: "danger",
  pending: "muted",
};

const VERDICT_LABEL: Record<PromotionVerdict, string> = {
  approved: "採用",
  rejected: "却下",
  pending: "未判定",
};

function severity(view: KnowledgeView): { tone: Tone; label: string } {
  if (!view.configured) return { tone: "muted", label: "未設定" };
  if (view.failures.length > 0) return { tone: "danger", label: "取得に失敗" };
  // 判定は毎日走る想定なので、2日以上残っているのは判定側が止まっている印。
  if (view.stalledDays !== null && view.stalledDays >= 2) return { tone: "danger", label: "判定が滞留" };
  if (view.counts.pending > 0 || view.truncated) return { tone: "warn", label: "判定待ちあり" };
  return { tone: "ok", label: "最新" };
}

function renderAttention(view: KnowledgeView): string {
  const items: string[] = [];

  for (const failure of view.failures) {
    items.push(
      `<li class="danger"><b>${escapeHtml(failure.source)}</b> を取得できませんでした（${escapeHtml(failure.reason)}）。
<span class="fix">AIDE_GITHUB_TOKEN に guchi-apps 配下の読み取り権限があるかを確認してください。</span></li>`,
    );
  }

  if (view.counts.pending > 0 && view.counts.approved === 0 && view.counts.rejected === 0) {
    items.push(
      `<li class="danger"><b>格上げ判定の記録が1件もありません。</b>知見メモ ${view.counts.items} 件がすべて未判定のまま残っています。
<span class="fix">判定は guchi-apps/docs の promote-knowledge.yml が毎日 05:00 JST に動きます。実行が失敗していないか確認してください。</span></li>`,
    );
  } else if (view.stalledDays !== null && view.stalledDays >= 2) {
    items.push(
      `<li><b>未判定のメモが ${view.stalledDays} 日ぶん残っています。</b>未判定 ${view.counts.pending} 件。
<span class="fix">最も古いメモの投稿は ${escapeHtml(formatDay(view.oldestPendingAt ?? ""))} です。</span></li>`,
    );
  }

  if (view.truncated) {
    items.push(
      `<li>知見メモが多く、<b>新しいものから順に読める範囲まで</b>しか表示していません。
<span class="fix">古いメモは一覧に出ていません。件数の内訳も表示できた範囲のものです。</span></li>`,
    );
  }

  return items.length ? `<ul class="attention">${items.join("")}</ul>` : "";
}

/** 共有知識のファイル1件。見出し（＝知見）を折りたたみの中に並べる。 */
function renderFile(file: KnowledgeFileView, repoUrl: string | null, branch: string | null): string {
  const link =
    repoUrl && branch
      ? `<a href="${escapeHtml(`${repoUrl}/blob/${branch}/${file.path}`)}" rel="noopener noreferrer">${escapeHtml(file.name)}</a>`
      : escapeHtml(file.name);

  const count = file.isIndex
    ? "索引"
    : `${file.sections.length}件${file.truncated ? "（本文が長く、途中までしか読めていません）" : ""}`;

  const sections = file.sections.length
    ? `<ul class="sections">${file.sections
        .map(
          (section) =>
            `<li><span class="t">${inlineMarkdown(section.title)}</span>
<span class="m">${section.confirmedAt ? `<span>確認 ${escapeHtml(section.confirmedAt)}</span>` : ""}${
              section.source ? `<span>${escapeHtml(section.source)}</span>` : ""
            }</span></li>`,
        )
        .join("")}</ul>`
    : `<p class="sub">見出しがありません（${escapeHtml(file.title)}）。</p>`;

  return `<li><details>
<summary><span class="fname">${link}</span><span class="fcount">${escapeHtml(count)}</span></summary>
${sections}
</details></li>`;
}

function adoptedCard(view: KnowledgeView): string {
  const adopted = view.adopted;
  if (!adopted) {
    return card({
      title: "共有知識に入っている知見",
      body: `<p class="sub">${
        view.configured ? "knowledge/ を読めませんでした。" : "GitHubのトークンが未設定です。"
      }</p>`,
      wide: true,
    });
  }

  return card({
    title: "共有知識に入っている知見",
    meta: `${adopted.sectionCount}件 / ${adopted.files.filter((file) => !file.isIndex).length}ファイル`,
    status: pill("ok", "採用済み"),
    body: `<p class="sub">${escapeHtml(view.repoUrl ? view.repoUrl.replace("https://github.com/", "") : "guchi-apps/docs")} の <span class="mono">knowledge/</span> にある1見出し＝1知見。格上げ判定が通ったものがここへ入ります。</p>
<ul class="files">${adopted.files.map((file) => renderFile(file, view.repoUrl, view.branch)).join("")}</ul>`,
    wide: true,
  });
}

function othersCard(view: KnowledgeView): string {
  if (view.others.length === 0) {
    return card({ title: "共有知識のそのほかの中身", body: `<p class="sub">読めませんでした。</p>` });
  }

  const rows = view.others.map((dir: KnowledgeDirectoryView) => [
    `<span class="key mono">${escapeHtml(dir.path)}/</span>`,
    `${dir.files.length}`,
    escapeHtml(
      dir.files
        .filter((file) => !file.isIndex)
        .map((file) => file.name)
        .join(" / ") || "（索引のみ）",
    ),
  ]);

  return card({
    title: "共有知識のそのほかの中身",
    meta: `${view.others.reduce((sum, dir) => sum + dir.files.length, 0)}ファイル`,
    body: `<p class="sub"><span class="mono">knowledge/</span> 以外は格上げ判定の対象外で、人が直接書く場所です。</p>
${table(["ディレクトリ", "数", "ファイル"], rows)}`,
  });
}

function sourcesCard(view: KnowledgeView): string {
  if (view.sources.length === 0) {
    return card({ title: "知見メモの出どころ", body: `<p class="sub">知見メモは見つかりませんでした。</p>` });
  }

  const rows = view.sources.map((source) => [
    `<span class="key mono">${escapeHtml(source.shortRepo)}</span>`,
    `${source.items}`,
    `${source.pending}`,
  ]);

  return card({
    title: "知見メモの出どころ",
    meta: `${view.sources.length}リポジトリ`,
    body: `<p class="sub">フリート全体のIssueに残っている知見メモ（<span class="mono">knowledge-candidate</span>）の件数。</p>
${table(["リポジトリ", "知見", "未判定"], rows)}`,
  });
}

/** 判定の理由・反映先。判定が付いていない行には「なぜ出ていないか」を出す。 */
function verdictDetail(memo: MemoEntryView, heading: string): string {
  if (memo.verdict === "pending") {
    return `<span class="why">格上げ判定がまだ走っていません${
      memo.state === "OPEN" ? "（Issueがopen。判定の対象は実装がマージ済みのものだけです）" : ""
    }</span>`;
  }

  // 判定コメントの見出しと知見の見出しを突き合わせる。**書式は保証されていない**ので、
  // 一致しなければIssue全体の判定だけを出す（黙って空欄にすると判定漏れに見える）。
  const note =
    memo.notes.find((item) => item.heading && (heading.includes(item.heading) || item.heading.includes(heading))) ??
    (memo.notes.length === 1 ? memo.notes[0] : undefined);

  const target = note?.target ? `<span class="mono">${escapeHtml(note.target)}</span> へ反映` : "";
  const reason = note?.reason
    ? `<span class="why">${inlineMarkdown(note.reason)}</span>`
    : `<span class="why">判定コメントに個別の記載がありません（出典のIssueを参照）</span>`;
  return `${target}${reason}`;
}

function memosCard(view: KnowledgeView): string {
  if (view.memos.length === 0) {
    return card({
      title: "格上げ判定の記録",
      body: `<p class="sub">${
        view.configured ? "知見メモは見つかりませんでした。" : "GitHubのトークンが未設定です。"
      }</p>`,
      wide: true,
    });
  }

  const rows: string[][] = [];
  for (const memo of view.memos) {
    for (const item of memo.items) {
      rows.push([
        pill(VERDICT_TONE[memo.verdict], VERDICT_LABEL[memo.verdict]),
        `${inlineMarkdown(item.heading)}<span class="why">${escapeHtml(memo.title)}</span>`,
        `<a class="mono" href="${escapeHtml(memo.url)}" rel="noopener noreferrer">${escapeHtml(
          `${memo.shortRepo}#${memo.number}`,
        )}</a>`,
        verdictDetail(memo, item.heading),
        `<span class="when">${escapeHtml(formatDay(item.confirmedAt ?? memo.postedAt))}</span>`,
      ]);
    }
  }

  return card({
    title: "格上げ判定の記録",
    meta: `${rows.length}件`,
    status:
      view.counts.pending > 0 ? pill("warn", `未判定 ${view.counts.pending}`) : pill("ok", "すべて判定済み"),
    body: `<p class="sub">新しい順。採用されたものには反映先、却下されたものには理由が入ります。判定の対象になるのは、実装がマージ済みのIssueに付いたメモだけです。</p>
${table(["判定", "知見", "出典", "理由・反映先", "確認日"], rows)}`,
    wide: true,
  });
}

/**
 * ページのHTMLを組み立てる純粋関数。テストはここに当てる。
 *
 * `authEnabled` は動作状況ページと揃えるためのもの。認証が無効な環境で
 * ログアウトのボタンを出すと、押しても何も起きない操作が並ぶ。
 */
export function renderKnowledgePage(
  view: KnowledgeView,
  session: StatusSession | null = null,
  authEnabled = true,
): string {
  const state = severity(view);
  const stamp = [
    `取得 ${formatJst(new Date(view.checkedAt))}`,
    view.repoUrl ? view.repoUrl.replace("https://github.com/", "") : "guchi-apps/docs",
    `知見 ${view.counts.adopted}件`,
    `知見メモ ${view.counts.items}件`,
    view.rateLimit ? `GraphQL残 ${view.rateLimit.remaining}` : "",
  ].filter(Boolean);

  const chips = view.configured
    ? `<ul class="chips">
<li>採用<span class="c">${view.counts.approved}</span></li>
<li>却下<span class="c">${view.counts.rejected}</span></li>
<li>未判定<span class="c">${view.counts.pending}</span></li>
</ul>`
    : `<p class="sub">AIDE_GITHUB_TOKEN が未設定のため、共有知識も知見メモも取得していません。</p>`;

  const body = `<section class="hero">
<div class="hero-top"><h1>共通知識と、その採用・却下の記録</h1>${pill(state.tone, state.label)}</div>
<div class="stamp">${stamp.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>
${renderAttention(view)}
${chips}
<p class="sub"><a href="/knowledge?refresh=1">取り直す</a>（通常は5分ぶん前の結果を使い回します）</p>
</section>
<div class="grid">
${adoptedCard(view)}
${othersCard(view)}
${sourcesCard(view)}
${memosCard(view)}
</div>`;

  return renderPage({
    title: TITLE,
    nav: siteNav("knowledge"),
    headerAction: authEnabled
      ? `${
          session?.email ? `<span class="who">${escapeHtml(session.email)}</span>` : ""
        }<form method="post" action="/status/logout"><button class="linkish" type="submit">ログアウト</button></form>`
      : "",
    body,
    footer:
      "guchi-apps/docs と各リポジトリのIssueから読み取った内容だけを表示しています。判定そのものは guchi-apps/docs の promote-knowledge.yml が行い、AIDEは行いません。",
  });
}

// ---- ハンドラ ----

export async function handleKnowledgePage(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: StatusOptions,
): Promise<void> {
  const session = await currentSession(req, options);
  if (!session) {
    // 動作状況ページと同じログイン画面を出す。**入口を別に作らない。**
    res
      .writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
      .end(renderLoginPage({ google: options.supabase !== null }));
    return;
  }

  const view = await loadView(url.searchParams.get("refresh") === "1");
  res
    .writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
    .end(renderKnowledgePage(view, session, options.authConfig.enabled));
}
