import type { IncomingMessage, ServerResponse } from "node:http";
import {
  GmailInbox,
  MAIL_ACTIONS,
  MAX_BATCH,
  type GmailFailureKind,
  type GmailInboxDeps,
  type GmailLabel,
  type GmailResult,
  type ListQuery,
  type MailAction,
  type MailInbox,
  type MailPage,
} from "../core/connectors/gmail-inbox/client.ts";
import { CROSS_ACCOUNT_REASON, loadExtraMailAccounts, MultiMailInbox, type ExtraMailAccount } from "../core/connectors/mail-accounts.ts";
import { ImapInbox, loadImapCredentials, type ImapInboxDeps } from "../core/connectors/imap-inbox/client.ts";
import { loadGmailInboxCredentials } from "../core/connectors/gmail-inbox/client.ts";
import { displayName, type MailDetail, type MailSummary } from "../core/connectors/gmail-inbox/message.ts";
import { escapeHtml, renderPage, siteNav } from "./layout.ts";
import { accountAction, currentSession, handleGatedPage, type LoginOptions } from "./login.ts";
import type { MailAccountInfo } from "../core/connectors/mail-accounts.ts";
import type { StatusSession } from "./session.ts";

/**
 * メール画面（`GET /mail`・`GET /mail/message`・`POST /mail/action`。#770）。
 *
 * Gmailの受信メールを一覧・本文で読み、既読/未読・アーカイブ・スター・ラベル・ゴミ箱で整理する。
 * **返信・送信・完全削除は持たない**（Issueで決めた範囲。どの操作もGmail上で元に戻せる）。
 * README「書き込みをどこまで持つか」の条件3の例外として #770 で判断している。
 *
 * **ログインの内側に置く。** 画面の関門は他の画面と同じ `handleGatedPage`／`currentSession`。
 * **さらに、メールボックスの持ち主本人に絞る。** ログインの許可はStatusHubの共通アクセス設定で決まり、
 * 本人以外も通りうる。メール本文は他の画面と性質が違うため、ログイン中のメールアドレスが
 * Gmailで認可したアカウント（`users.getProfile`）と一致するときだけGmailの中身を出し、操作も受け付ける。
 * メールアドレスを持たないセッション（`AIDE_AUTH_DISABLED=1`・パスワードでのログイン）は本人と
 * 確かめられないので開けない（計画レビュー指摘1）。
 *
 * **メール本文はAIDEに残さない。** 開くたびにGmail APIを叩き、ログにも件名・差出人・本文を出さない
 * （失敗の種類だけを出す）。
 *
 * HTMLメールは `sandbox`（スクリプト不可）の `iframe srcdoc` に閉じ込め、内側のCSPで外部の読み込みを
 * 既定で止める。外部画像は差出人へ「開いた」ことを知らせる追跡に使われるため、画面の「画像を表示」を
 * 押したときだけ許す。
 */

const TITLE = "メール | AIDE";

/** 画面上部のタブ。`labelIds` はGmail APIの `labelIds`（AND条件）にそのまま渡す。 */
interface MailView {
  key: string;
  label: string;
  labelIds: string[];
  includeSpamTrash?: boolean;
}

export const MAIL_VIEWS: readonly MailView[] = [
  { key: "inbox", label: "受信トレイ", labelIds: ["INBOX"] },
  { key: "unread", label: "未読", labelIds: ["INBOX", "UNREAD"] },
  { key: "starred", label: "スター", labelIds: ["STARRED"] },
  { key: "all", label: "すべて", labelIds: [] },
  { key: "trash", label: "ゴミ箱", labelIds: ["TRASH"], includeSpamTrash: true },
];

const DEFAULT_VIEW = MAIL_VIEWS[0]!;

/**
 * メッセージ ID。パスやAPIのURLへ載せる前に必ず通す。Gmailは16進、IMAPは
 * `<フォルダ(base64url)>.<UIDVALIDITY>.<UID>`（#782）なので、英数字・`_`・`-`・`.` の範囲で受ける。
 */
export function isMessageId(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.~-]{1,320}$/.test(value);
}

/** ラベルID（Gmailの `INBOX`・`Label_12` など。IMAPはフォルダを表す `F<base64url>`）。 */
export function isLabelId(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_~-]{1,220}$/.test(value);
}

function isPageToken(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,700}$/.test(value);
}

/**
 * 操作の後に戻る先。**メール画面の中だけを許す。** 値はフォームの hidden で利用者の手を通るため、
 * 外部URLやプロトコル相対（`//evil`）をそのまま `Location` へ載せると踏み台になる。
 */
export function safeMailBack(value: string | null | undefined): string {
  if (typeof value !== "string") return "/mail";
  if (!/^\/mail(\/message)?(\?[^\s\\]*)?$/.test(value)) return "/mail";
  return value;
}

export interface ListState {
  view: MailView;
  /** ユーザーラベルで絞っているときのラベルID。 */
  labelId: string | null;
  /** 複数アカウントのときに絞っているアカウントの鍵（#794）。null は全アカウント。 */
  account: string | null;
  q: string;
  pageToken: string | null;
}

export function parseListState(params: URLSearchParams): ListState {
  const view = MAIL_VIEWS.find((v) => v.key === params.get("view")) ?? DEFAULT_VIEW;
  const label = params.get("label");
  const q = (params.get("q") ?? "").trim().slice(0, 200);
  const page = params.get("page");
  const acct = params.get("acct");
  return {
    view,
    labelId: isLabelId(label) ? label : null,
    account: acct && /^[a-z0-9]{1,12}$/.test(acct) ? acct : null,
    q,
    pageToken: isPageToken(page) ? page : null,
  };
}

export function toListQuery(state: ListState): ListQuery {
  return {
    labelIds: state.labelId ? [state.labelId] : state.view.labelIds,
    q: state.q,
    pageToken: state.pageToken,
    account: state.account,
    includeSpamTrash: state.labelId ? false : (state.view.includeSpamTrash ?? false),
  };
}

/** 一覧のURL。ページ送り・戻り先に使う。 */
export function listHref(state: ListState, overrides: { pageToken?: string | null } = {}): string {
  const params = new URLSearchParams();
  if (state.labelId) params.set("label", state.labelId);
  else if (state.view !== DEFAULT_VIEW) params.set("view", state.view.key);
  if (state.account && !state.labelId) params.set("acct", state.account);
  if (state.q) params.set("q", state.q);
  const page = overrides.pageToken === undefined ? state.pageToken : overrides.pageToken;
  if (page) params.set("page", page);
  const query = params.toString();
  return query ? `/mail?${query}` : "/mail";
}

const dateFormat = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
const timeFormat = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" });
const dayKeyFormat = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" });

/** 一覧の日時。今日なら時刻だけ、それ以外は日付まで。 */
export function formatListDate(at: number | null, now: Date): string {
  if (at === null) return "";
  const date = new Date(at);
  if (dayKeyFormat.format(date) === dayKeyFormat.format(now)) return timeFormat.format(date);
  return dateFormat.format(date).split(" ")[0]!;
}

function formatFullDate(at: number | null): string {
  return at === null ? "" : dateFormat.format(new Date(at));
}

/** 画面が読んでいる取得元（#782）。 */
export type MailSource = "gmail" | "imap";

/** 画面に出す失敗の種類。Gmail側の失敗に「持ち主本人ではない」を加えたもの。 */
export type MailFailure = GmailFailureKind | "not_owner";

const FAILURE_MESSAGES: Record<MailFailure, string> = {
  not_owner:
    "このメールボックスの持ち主（Gmailで認可したアカウント）でログインしたときだけ開けます。認証が無効な環境やパスワードでのログインでは開けません。",
  unconfigured:
    "Gmailの読み取り用の資格情報（AIDE_GMAIL_INBOX_REFRESH_TOKEN）が未設定です。トークンを発行して本番の環境変数へ配線すると使えるようになります。",
  unauthorized:
    "Gmailの認可が切れているか、権限が足りません。gmail.modify のリフレッシュトークンを発行し直してください（同意画面が「テスト」のままだと7日で失効します）。",
  not_found: "メールが見つかりませんでした。削除されたか、別の操作で移動した可能性があります。",
  failed: "Gmailへの接続に失敗しました。時間をおいて開き直してください。",
};

const IMAP_FAILURE_MESSAGES: Record<MailFailure, string> = {
  ...FAILURE_MESSAGES,
  not_owner:
    "このメールボックスの持ち主（IMAPのユーザー名のメールアドレス）でログインしたときだけ開けます。認証が無効な環境やパスワードでのログインでは開けません。",
  unconfigured: "IMAPの接続情報（AIDE_IMAP_HOST・AIDE_IMAP_USER・AIDE_IMAP_PASSWORD）が未設定です。",
  unauthorized:
    "IMAPのログインに失敗しました。ユーザー名・パスワード（アプリパスワード）を確かめてください。ユーザー名がメールアドレスでないときは AIDE_IMAP_OWNER_EMAIL も必要です。",
  failed: "IMAPサーバーとのやり取りに失敗しました。時間をおいて開き直してください。",
};

function failureMessage(failure: MailFailure, source: MailSource): string {
  return (source === "imap" ? IMAP_FAILURE_MESSAGES : FAILURE_MESSAGES)[failure];
}

const DONE_MESSAGES: Record<string, string> = {
  read: "既読にしました",
  unread: "未読にしました",
  archive: "アーカイブしました",
  inbox: "受信トレイへ戻しました",
  star: "スターを付けました",
  unstar: "スターを外しました",
  trash: "ゴミ箱へ移動しました（ゴミ箱から戻せます。Gmailは30日以内）",
  untrash: "ゴミ箱から戻しました",
  "label-add": "ラベルを付けました",
  "label-remove": "ラベルを外しました",
};

/** メール画面だけで使う部品の見た目。共通の配色トークン（`layout.ts`）だけを使う。 */
const MAIL_STYLE = `<style>
.mail-tabs{display:flex;flex-wrap:wrap;gap:.3rem;margin:0;padding:0;list-style:none}
.mail-tabs a{display:inline-block;font-size:.84rem;text-decoration:none;color:var(--ink-2);padding:.3rem .7rem;
 border:1px solid var(--line);background:var(--panel)}
.mail-tabs a.on{color:var(--on-accent);background:var(--accent);border-color:var(--accent)}
.mail-search{display:flex;gap:.4rem}
.mail-search input{flex:1;min-width:0;font:inherit;font-size:.9rem;padding:.4rem .6rem;border:1px solid var(--line);
 background:var(--panel);color:var(--ink)}
.mail-btn{font:inherit;font-size:.82rem;padding:.35rem .75rem;min-height:2.2rem;border:1px solid var(--line);
 background:var(--panel);color:var(--ink);cursor:pointer}
.mail-btn:hover{border-color:var(--accent);color:var(--accent)}
.mail-btn.primary{background:var(--accent);color:var(--on-accent);border-color:var(--accent)}
.mail-btn.danger{color:var(--bad)}
.mail-bar{display:flex;flex-wrap:wrap;gap:.4rem;align-items:center}
.mail-flash{margin:0;font-size:.85rem;padding:.45rem .7rem;border-left:3px solid var(--ok);background:var(--ok-bg);color:var(--ink)}
.mail-list{list-style:none;margin:0;padding:0;background:var(--panel);border:1px solid var(--line)}
.mail-list li{display:flex;gap:.6rem;align-items:flex-start;padding:.55rem .8rem;border-bottom:1px solid var(--line-2)}
.mail-list li:last-child{border-bottom:0}
.mail-list input[type=checkbox]{margin-top:.35rem;width:1.1rem;height:1.1rem;flex:none}
.mail-list a.row{flex:1;min-width:0;text-decoration:none;color:var(--ink-2);display:grid;
 grid-template-columns:minmax(0,1fr) auto;column-gap:.6rem}
.mail-list .from{font-size:.86rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mail-list .at{font-family:ui-monospace,monospace;font-size:.74rem;color:var(--muted)}
.mail-list .subj{grid-column:1/-1;font-size:.88rem;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mail-list .snip{grid-column:1/-1;font-size:.78rem;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mail-list li.unread .from,.mail-list li.unread .subj{font-weight:700;color:var(--ink)}
.mail-list .star{color:var(--wr)}
.mail-empty{margin:0;padding:1rem;color:var(--muted);background:var(--panel);border:1px solid var(--line)}
.mail-pager{display:flex;justify-content:space-between;gap:.5rem;font-size:.85rem}
.mail-head h1{font-size:1.15rem;margin:0;line-height:1.5;overflow-wrap:anywhere}
.mail-meta{display:grid;grid-template-columns:auto minmax(0,1fr);gap:.1rem .8rem;margin:0;font-size:.82rem}
.mail-meta dt{color:var(--muted)}
.mail-meta dd{margin:0;overflow-wrap:anywhere}
.mail-chips{display:flex;flex-wrap:wrap;gap:.3rem;margin:0;padding:0;list-style:none}
.mail-chips li{display:inline-flex;align-items:center;gap:.25rem;font-size:.74rem;padding:0 .2rem 0 .5rem;
 border:1px solid var(--accent);color:var(--accent);background:var(--accent-soft)}
.mail-chips button{font:inherit;border:0;background:none;color:inherit;cursor:pointer;padding:.1rem .3rem}
.mail-body{width:100%;height:70vh;min-height:20rem;border:1px solid var(--line);background:#fff;resize:vertical}
.mail-text{margin:0;padding:.9rem;background:var(--panel);border:1px solid var(--line);white-space:pre-wrap;
 overflow-wrap:anywhere;font-size:.88rem;line-height:1.65}
.mail-select{font:inherit;font-size:.82rem;padding:.3rem;border:1px solid var(--line);background:var(--panel);color:var(--ink);max-width:14rem}
.mail-acct{font-size:.7rem;color:var(--accent);border:1px solid var(--accent);padding:0 .3rem;margin-right:.35rem}
.mail-note{margin:0;font-size:.78rem;color:var(--muted)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
</style>`;

function tabsHtml(state: ListState, labels: GmailLabel[], accounts: readonly MailAccountInfo[]): string {
  const accountTabs =
    accounts.length > 1
      ? `<ul class="mail-tabs" aria-label="表示するアカウント">${[{ key: null, name: "すべてのアカウント" }, ...accounts]
          .map((a) => {
            const on = !state.labelId && state.account === a.key;
            const href = listHref({ ...state, labelId: null, account: a.key, q: "", pageToken: null });
            return `<li><a href="${escapeHtml(href)}"${on ? ' class="on" aria-current="page"' : ""}>${escapeHtml(a.name)}</a></li>`;
          })
          .join("")}</ul>`
      : "";
  const viewTabs = MAIL_VIEWS.map((view) => {
    const on = !state.labelId && view === state.view;
    const href = listHref({ view, labelId: null, account: state.account, q: "", pageToken: null });
    return `<li><a href="${escapeHtml(href)}"${on ? ' class="on" aria-current="page"' : ""}>${escapeHtml(view.label)}</a></li>`;
  });
  const labelTabs = userLabels(labels).map((label) => {
    const on = state.labelId === label.id;
    const href = listHref({ view: DEFAULT_VIEW, labelId: label.id, account: null, q: "", pageToken: null });
    return `<li><a href="${escapeHtml(href)}"${on ? ' class="on" aria-current="page"' : ""}>${escapeHtml(label.name)}</a></li>`;
  });
  return `${accountTabs}<ul class="mail-tabs" aria-label="表示するメール">${[...viewTabs, ...labelTabs].join("")}</ul>`;
}

function userLabels(labels: GmailLabel[]): GmailLabel[] {
  return labels.filter((l) => l.type === "user").sort((a, b) => a.name.localeCompare(b.name, "ja"));
}

function searchHtml(state: ListState, source: MailSource): string {
  const hidden = state.labelId
    ? `<input type="hidden" name="label" value="${escapeHtml(state.labelId)}">`
    : (state.view !== DEFAULT_VIEW ? `<input type="hidden" name="view" value="${escapeHtml(state.view.key)}">` : "") +
      (state.account ? `<input type="hidden" name="acct" value="${escapeHtml(state.account)}">` : "");
  return `<form class="mail-search" method="get" action="/mail" role="search">${hidden}
<input type="search" name="q" value="${escapeHtml(state.q)}" placeholder="${source === "imap" ? "検索する語（件名・差出人・本文）" : "Gmailの検索式（from:… subject:…）"}" aria-label="メールを検索">
<button class="mail-btn" type="submit">検索</button></form>`;
}

function flashHtml(params: URLSearchParams): string {
  const done = params.get("done");
  if (done && DONE_MESSAGES[done]) {
    const count = Number(params.get("n"));
    const suffix = Number.isInteger(count) && count > 1 ? `（${count}件）` : "";
    return `<p class="mail-flash" role="status">${escapeHtml(DONE_MESSAGES[done]!)}${suffix}</p>`;
  }
  const error = params.get("error");
  if (error) {
    const kind = (Object.keys(FAILURE_MESSAGES) as MailFailure[]).find((k) => k === error);
    const message = error === "cross_account" ? CROSS_ACCOUNT_REASON : kind ? FAILURE_MESSAGES[kind] : "操作できませんでした。";
    return `<p class="err" role="alert">${escapeHtml(message)}</p>`;
  }
  return "";
}

/** 一括操作のボタン。ゴミ箱を見ているときは「戻す」だけを出す。 */
function bulkButtons(state: ListState): string {
  if (!state.labelId && state.view.key === "trash") {
    return `<button class="mail-btn" type="submit" name="action" value="untrash">ゴミ箱から戻す</button>`;
  }
  const archiveOrInbox =
    !state.labelId && state.view.key !== "inbox" && state.view.key !== "unread"
      ? `<button class="mail-btn" type="submit" name="action" value="inbox">受信トレイへ</button>`
      : `<button class="mail-btn" type="submit" name="action" value="archive">アーカイブ</button>`;
  return [
    `<button class="mail-btn" type="submit" name="action" value="read">既読</button>`,
    `<button class="mail-btn" type="submit" name="action" value="unread">未読</button>`,
    archiveOrInbox,
    `<button class="mail-btn danger" type="submit" name="action" value="trash">ゴミ箱へ</button>`,
  ].join("");
}

function rowHtml(message: MailSummary, back: string, now: Date): string {
  const href = `/mail/message?id=${encodeURIComponent(message.id)}&back=${encodeURIComponent(back)}`;
  const star = message.starred ? `<span class="star" aria-label="スター付き">★</span> ` : "";
  const unreadLabel = message.unread ? `<span class="sr">未読 </span>` : "";
  return `<li${message.unread ? ' class="unread"' : ""}>
<input type="checkbox" name="id" value="${escapeHtml(message.id)}" aria-label="選択: ${escapeHtml(message.subject || "(件名なし)")}">
<a class="row" href="${escapeHtml(href)}"><span class="from">${unreadLabel}${star}${message.account ? `<span class="mail-acct">${escapeHtml(message.account)}</span>` : ""}${escapeHtml(displayName(message.from) || "(差出人なし)")}</span><span class="at">${escapeHtml(formatListDate(message.receivedAt, now))}</span><span class="subj">${escapeHtml(message.subject || "(件名なし)")}</span><span class="snip">${escapeHtml(message.snippet)}</span></a></li>`;
}

export interface MailListView {
  state: ListState;
  labels: GmailLabel[];
  page: MailPage | null;
  failure: MailFailure | null;
  params: URLSearchParams;
  headerAction: string;
  authEnabled: boolean;
  now: Date;
  /** 取得元。省略はGmail。 */
  source?: MailSource;
  /** 複数アカウントを束ねているときのアカウント一覧（#794）。 */
  accounts?: readonly MailAccountInfo[];
}

export function renderMailList(view: MailListView): string {
  const { state } = view;
  const back = listHref(state);
  const title = state.labelId
    ? (view.labels.find((l) => l.id === state.labelId)?.name ?? "ラベル")
    : state.view.label;

  let content: string;
  if (view.failure) {
    content = `<p class="err" role="alert">${escapeHtml(failureMessage(view.failure, view.source ?? "gmail"))}</p>`;
  } else if (!view.page || view.page.messages.length === 0) {
    content = `<p class="mail-empty">${state.q ? "検索に一致するメールはありません。" : "メールはありません。"}</p>`;
  } else {
    const rows = view.page.messages.map((m) => rowHtml(m, back, view.now)).join("\n");
    const next = view.page.nextPageToken
      ? `<a href="${escapeHtml(listHref(state, { pageToken: view.page.nextPageToken }))}">次のページ →</a>`
      : "";
    const first = state.pageToken ? `<a href="${escapeHtml(listHref(state, { pageToken: null }))}">← 最初のページ</a>` : "<span></span>";
    const failed = view.page.failedAccounts?.length
      ? `<p class="err" role="alert">読み込めなかったアカウントがあります: ${escapeHtml(view.page.failedAccounts.join("、"))}</p>`
      : "";
    content = `${failed}<form method="post" action="/mail/action">
<input type="hidden" name="back" value="${escapeHtml(back)}">
<div class="mail-bar" role="group" aria-label="選択したメールの操作">${bulkButtons(state)}</div>
<ul class="mail-list">${rows}</ul>
</form>
<div class="mail-pager">${first}${next}</div>`;
  }

  const authWarning = view.authEnabled
    ? ""
    : `<p class="err">認証が無効な環境で開いています（AIDE_AUTH_DISABLED=1）。誰でもメールを読めます。</p>`;

  const body = `${MAIL_STYLE}
<section class="hero"><div class="hero-top"><h1>${escapeHtml(title)}</h1></div>
${tabsHtml(state, view.labels, view.accounts ?? [])}
${searchHtml(state, view.source ?? "gmail")}</section>
${authWarning}${flashHtml(view.params)}
${content}`;
  return renderPage({ title: TITLE, nav: siteNav("mail"), headerAction: view.headerAction, body });
}

/**
 * HTMLメールを閉じ込める `srcdoc` の中身。
 *
 * - `sandbox` に `allow-scripts` を付けない＝メール内のスクリプトは動かない。`allow-same-origin` も付けない
 *   ＝AIDEのCookieや画面へ触れない
 * - 内側のCSPで、外部の読み込み（画像・CSS・フォント・フレーム）を既定で止める。画像だけは利用者が
 *   「画像を表示」を押したときに `https:` を許す
 * - リンクは `<base target="_blank">` で新しいタブに開く（`allow-popups-to-escape-sandbox` で通常のページとして開く）
 */
export function emailSrcdoc(html: string, showImages: boolean): string {
  const img = showImages ? "data: https:" : "data:";
  const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src ${img}; font-src data:`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"><meta name="referrer" content="no-referrer"><style>body{margin:12px;font-family:system-ui,sans-serif;color:#131b22;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style></head><body>${html}</body></html>`;
}

/** 本文に外部画像（`http(s)://` の `src`）が含まれているか。「画像を表示」ボタンを出すかの判断に使う。 */
export function hasRemoteImages(html: string): boolean {
  return /<img[^>]+src\s*=\s*["']?\s*https?:/i.test(html) || /url\(\s*["']?https?:/i.test(html);
}

function actionButton(action: MailAction, label: string, extraClass = ""): string {
  return `<button class="mail-btn${extraClass ? ` ${extraClass}` : ""}" type="submit" name="action" value="${action}">${escapeHtml(label)}</button>`;
}

export interface MailDetailView {
  message: MailDetail | null;
  labels: GmailLabel[];
  failure: MailFailure | null;
  back: string;
  showImages: boolean;
  params: URLSearchParams;
  headerAction: string;
  authEnabled: boolean;
  /** 取得元。省略はGmail。 */
  source?: MailSource;
}

export function renderMailDetail(view: MailDetailView): string {
  const backLink = `<a href="${escapeHtml(view.back)}">← 一覧へ戻る</a>`;
  const message = view.message;
  if (!message) {
    const failure = view.failure ?? "not_found";
    const body = `${MAIL_STYLE}${backLink}<p class="err" role="alert">${escapeHtml(failureMessage(failure, view.source ?? "gmail"))}</p>`;
    return renderPage({ title: TITLE, nav: siteNav("mail"), headerAction: view.headerAction, body });
  }

  const source = view.source ?? "gmail";
  const self = `/mail/message?id=${encodeURIComponent(message.id)}&back=${encodeURIComponent(view.back)}`;
  const inTrash = message.labelIds.includes("TRASH");
  const inInbox = message.labelIds.includes("INBOX");
  const buttons = inTrash
    ? actionButton("untrash", "ゴミ箱から戻す")
    : [
        message.unread ? actionButton("read", "既読にする", "primary") : actionButton("unread", "未読にする"),
        inInbox ? actionButton("archive", "アーカイブ") : actionButton("inbox", "受信トレイへ戻す"),
        message.starred ? actionButton("unstar", "スターを外す") : actionButton("star", "スターを付ける"),
        actionButton("trash", "ゴミ箱へ", "danger"),
      ].join("");

  const byId = new Map(view.labels.map((l) => [l.id, l]));
  const attached = message.labelIds
    .map((id) => byId.get(id))
    .filter((l): l is GmailLabel => l !== undefined && l.type === "user");
  const chips = source === "gmail" && attached.length
    ? `<ul class="mail-chips" aria-label="付いているラベル">${attached
        .map(
          (l) =>
            `<li>${escapeHtml(l.name)}<form method="post" action="/mail/action"><input type="hidden" name="id" value="${escapeHtml(message.id)}"><input type="hidden" name="label" value="${escapeHtml(l.id)}"><input type="hidden" name="back" value="${escapeHtml(self)}"><button type="submit" name="action" value="label-remove" aria-label="ラベル「${escapeHtml(l.name)}」を外す">×</button></form></li>`,
        )
        .join("")}</ul>`
    : "";
  const addable = userLabels(view.labels).filter((l) => !message.labelIds.includes(l.id));
  const addLabel = source === "gmail" && addable.length
    ? `<form class="mail-bar" method="post" action="/mail/action"><input type="hidden" name="id" value="${escapeHtml(message.id)}"><input type="hidden" name="back" value="${escapeHtml(self)}"><select class="mail-select" name="label" aria-label="付けるラベル">${addable
        .map((l) => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.name)}</option>`)
        .join("")}</select><button class="mail-btn" type="submit" name="action" value="label-add">ラベルを付ける</button></form>`
    : "";

  // 一覧へ戻る操作（アーカイブ・ゴミ箱）は一覧へ、その場で状態が変わるだけの操作は本文へ戻す。
  const actionsForm = `<form class="mail-bar" method="post" action="/mail/action" role="group" aria-label="このメールの操作">
<input type="hidden" name="id" value="${escapeHtml(message.id)}">
<input type="hidden" name="back" value="${escapeHtml(self)}">
<input type="hidden" name="list" value="${escapeHtml(view.back)}">
${buttons}</form>`;

  let bodyHtml: string;
  if (message.html !== null) {
    const remote = hasRemoteImages(message.html);
    const imageToggle =
      remote && !view.showImages
        ? `<p class="mail-note">外部の画像を止めています（開封の追跡に使われることがあるため）。<a href="${escapeHtml(`${self}&images=1`)}">画像を表示</a></p>`
        : "";
    bodyHtml = `${imageToggle}<iframe class="mail-body" title="メール本文" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" srcdoc="${escapeHtml(emailSrcdoc(message.html, view.showImages))}"></iframe>`;
  } else if (message.text !== null) {
    bodyHtml = `<pre class="mail-text">${escapeHtml(message.text)}</pre>`;
  } else {
    bodyHtml = `<p class="mail-empty">本文はありません。</p>`;
  }

  const attachments = message.attachments.length
    ? `<p class="mail-note">添付: ${message.attachments
        .map((a) => `${escapeHtml(a.filename)}（${escapeHtml(formatSize(a.size))}）`)
        .join("、")}。添付は${source === "imap" ? "お使いのメールアプリ" : "Gmail"}で開いてください。</p>`
    : "";

  const meta = [
    ...(message.account ? [["アカウント", message.account]] : []),
    ["差出人", message.from],
    ["宛先", message.to],
    ...(message.cc ? [["CC", message.cc]] : []),
    ["日時", formatFullDate(message.receivedAt)],
  ]
    .map(([k, v]) => `<dt>${escapeHtml(k!)}</dt><dd>${escapeHtml(v!)}</dd>`)
    .join("");

  const gmailLink = source === "imap" || (message.account && message.account !== "メイン") ? "<span></span>" : `<a href="https://mail.google.com/mail/u/0/#all/${encodeURIComponent(message.threadId)}" target="_blank" rel="noopener noreferrer">Gmailで開く</a>`;

  const authWarning = view.authEnabled
    ? ""
    : `<p class="err">認証が無効な環境で開いています（AIDE_AUTH_DISABLED=1）。誰でもメールを読めます。</p>`;

  const body = `${MAIL_STYLE}
<div class="mail-pager">${backLink}${gmailLink}</div>
${authWarning}${flashHtml(view.params)}
<section class="hero mail-head"><h1>${escapeHtml(message.subject || "(件名なし)")}</h1>
<dl class="mail-meta">${meta}</dl>
${chips}
${actionsForm}
${addLabel}</section>
${bodyHtml}
${attachments}`;
  return renderPage({ title: TITLE, nav: siteNav("mail"), headerAction: view.headerAction, body });
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

// ---- ハンドラ ----

export interface MailDeps extends GmailInboxDeps {
  connect?: (deps: GmailInboxDeps) => Promise<GmailResult<MailInbox>>;
  /** IMAPの取得元の差し替え（テスト用）。 */
  imap?: ImapInboxDeps;
  /** 取得元の指定（テスト用）。省略時は環境変数から決める。 */
  source?: MailSource;
  /** 追加アカウントの指定（テスト用）。省略時は `AIDE_MAIL_ACCOUNTS` から読む（#794）。 */
  extraAccounts?: ExtraMailAccount[];
  currentSession?: typeof currentSession;
  now?: () => Date;
}

/**
 * 画面が読む取得元を決める（#782）。**1つの環境では1つだけ**（Gmailと併用して切り替える画面は持たない）。
 * `AIDE_MAIL_SOURCE`（`gmail` / `imap`）で明示でき、省略時はGmailの読み取り用トークンがあればGmail、
 * 無くてIMAPの接続情報があればIMAP、どちらも無ければGmail（未設定の案内を出す）。
 */
export function selectMailSource(): MailSource {
  const explicit = (process.env["AIDE_MAIL_SOURCE"] ?? "").trim().toLowerCase();
  if (explicit === "gmail" || explicit === "imap") return explicit;
  if (loadGmailInboxCredentials()) return "gmail";
  return loadImapCredentials() ? "imap" : "gmail";
}

function sourceOf(deps: MailDeps): MailSource {
  return deps.source ?? selectMailSource();
}

async function connectMain(deps: MailDeps): Promise<GmailResult<MailInbox>> {
  if (deps.connect) return deps.connect(deps);
  if (sourceOf(deps) === "imap") return ImapInbox.connect(deps.imap ?? {});
  return GmailInbox.connect(deps);
}

/** メインの取得元に、追加アカウントがあれば束ねる（#794）。無ければメインだけで従来どおり。 */
async function connect(deps: MailDeps): Promise<GmailResult<MailInbox>> {
  const main = await connectMain(deps);
  if (!main.ok) return main;
  const extras = deps.extraAccounts ?? loadExtraMailAccounts();
  if (extras.length === 0) return main;
  return MultiMailInbox.connect(main.value, extras, deps.imap ?? {});
}

function logFailure(where: string, kind: MailFailure, reason: string): void {
  // 件名・差出人・本文・IDは出さない。失敗の種類と理由（ステータスコード程度）だけ。
  if (kind !== "unconfigured") console.warn(`[mail] ${where}: ${kind} ${reason}`);
}

/** Morrow向けのAPI（`src/api/mail.ts`。#795）も同じ粒度でログを残す。 */
export const logMailFailure = logFailure;

/**
 * 取得元へつなぎ、メールボックスの持ち主のメールアドレス（Gmailは `users.getProfile`、IMAPは
 * `AIDE_IMAP_OWNER_EMAIL` など。複数のアカウントを束ねるときはメインのアカウント）を引く。画面（`openMailbox`）とMorrow向けのAPI（`src/api/mail.ts`。#795）が
 * 共用する。持ち主との照合は呼び出し側が行う（画面はログイン中の人と、APIは応答に載せて呼び出し元が）。
 */
export async function connectMailbox(
  deps: MailDeps,
): Promise<{ ok: true; inbox: MailInbox; owner: string } | { ok: false; kind: MailFailure }> {
  const inbox = await connect(deps);
  if (!inbox.ok) {
    logFailure("connect", inbox.kind, inbox.reason);
    return { ok: false, kind: inbox.kind };
  }
  const profile = await inbox.value.profileEmail();
  if (!profile.ok) {
    logFailure("profile", profile.kind, profile.reason);
    return { ok: false, kind: profile.kind };
  }
  return { ok: true, inbox: inbox.value, owner: profile.value.trim().toLowerCase() };
}

/**
 * Gmailへつなぎ、ログイン中の人がメールボックスの持ち主本人かを確かめる。
 * **一覧・本文・操作のすべてがここを通る。** 画面ごとに判定を書くと、片方だけ抜けて素通しになる。
 */
export async function openMailbox(
  session: StatusSession,
  deps: MailDeps,
): Promise<{ ok: true; inbox: MailInbox } | { ok: false; kind: MailFailure }> {
  if (!session.email) return { ok: false, kind: "not_owner" };
  const mailbox = await connectMailbox(deps);
  if (!mailbox.ok) return mailbox;
  if (mailbox.owner !== session.email.trim().toLowerCase()) {
    // 誰が開こうとしたかは残すが、Gmail側のアドレスはログに出さない。
    console.warn("[mail] 持ち主ではないログインからのアクセスを断りました");
    return { ok: false, kind: "not_owner" };
  }
  return { ok: true, inbox: mailbox.inbox };
}

export async function handleMailListPage(
  req: IncomingMessage,
  res: ServerResponse,
  options: LoginOptions,
  deps: MailDeps = {},
): Promise<void> {
  const params = new URL(req.url ?? "/", "http://localhost").searchParams;
  const state = parseListState(params);

  await handleGatedPage(req, res, options, "/mail", async (session) => {
    const base = {
      state,
      params,
      headerAction: accountAction(session, options.authConfig.enabled),
      authEnabled: options.authConfig.enabled,
      now: (deps.now ?? (() => new Date()))(),
      source: sourceOf(deps),
    };
    const mailbox = await openMailbox(session, deps);
    if (!mailbox.ok) return renderMailList({ ...base, labels: [], page: null, failure: mailbox.kind });
    const [labels, page] = await Promise.all([mailbox.inbox.labels(), mailbox.inbox.list(toListQuery(state))]);
    if (!page.ok) logFailure("list", page.kind, page.reason);
    return renderMailList({
      ...base,
      accounts: mailbox.inbox.accounts ?? [],
      labels: labels.ok ? labels.value : [],
      page: page.ok ? page.value : null,
      failure: page.ok ? null : page.kind,
    });
  });
}

export async function handleMailMessagePage(
  req: IncomingMessage,
  res: ServerResponse,
  options: LoginOptions,
  deps: MailDeps = {},
): Promise<void> {
  const params = new URL(req.url ?? "/", "http://localhost").searchParams;
  const id = params.get("id");
  const back = safeMailBack(params.get("back"));
  const showImages = params.get("images") === "1";

  // ログイン画面からの戻り先はナビに載っている画面に限るため、本文ではなく一覧へ戻す。
  await handleGatedPage(req, res, options, "/mail", async (session) => {
    const base = {
      back,
      showImages,
      params,
      headerAction: accountAction(session, options.authConfig.enabled),
      authEnabled: options.authConfig.enabled,
      source: sourceOf(deps),
    };
    if (!isMessageId(id)) return renderMailDetail({ ...base, message: null, labels: [], failure: "not_found" });
    const mailbox = await openMailbox(session, deps);
    if (!mailbox.ok) return renderMailDetail({ ...base, message: null, labels: [], failure: mailbox.kind });
    const [labels, message] = await Promise.all([mailbox.inbox.labels(), mailbox.inbox.get(id)]);
    if (!message.ok) logFailure("get", message.kind, message.reason);
    return renderMailDetail({
      ...base,
      message: message.ok ? message.value : null,
      labels: labels.ok ? labels.value : [],
      failure: message.ok ? null : message.kind,
    });
  });
}

/** フォームの受け口。1ページ分のID（25件×十数文字）が収まれば足りる。 */
const MAX_FORM_BYTES = 16 * 1024;

async function readForm(req: IncomingMessage): Promise<URLSearchParams | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_FORM_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

/**
 * 同じサイトの画面から送られたか。
 *
 * セッションCookieは `SameSite=Lax` で別サイトからの送信には付かないが、**同じ登録ドメインの別の
 * サブドメイン（他の個人アプリ）は「同じサイト」扱いで Cookie が付く。** メールを動かせる操作なので、
 * `Origin`（無ければ `Sec-Fetch-Site`）でAIDE自身の画面から来たことまで確かめる。
 * **どちらも無い送信は断る**（計画レビュー指摘2）。今のブラウザ・WKWebView（iOSアプリ）はフォームの
 * POSTに `Origin` を付けるので、無いのは画面を通らない送信だけになる。
 */
export function isSameOriginPost(req: IncomingMessage, baseUrl: string): boolean {
  const origin = req.headers["origin"];
  if (typeof origin === "string" && origin !== "null") {
    try {
      return new URL(origin).host === new URL(baseUrl).host;
    } catch {
      return false;
    }
  }
  const site = req.headers["sec-fetch-site"];
  return site === "same-origin";
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { Location: location, "Cache-Control": "no-store" }).end();
}

function withParams(path: string, params: Record<string, string>): string {
  const url = new URL(path, "http://localhost");
  for (const key of ["done", "n", "error"]) url.searchParams.delete(key);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return `${url.pathname}${url.search}`;
}

/** 本文画面からの操作のうち、そのメールが今の一覧から外れるもの。終わったら一覧へ戻す。 */
const LEAVES_LIST: ReadonlySet<MailAction> = new Set(["archive", "trash", "untrash", "inbox"]);

export async function handleMailAction(
  req: IncomingMessage,
  res: ServerResponse,
  options: LoginOptions,
  deps: MailDeps = {},
): Promise<void> {
  const session = await (deps.currentSession ?? currentSession)(req, options);
  if (!session) {
    req.resume();
    redirect(res, "/mail");
    return;
  }
  if (!isSameOriginPost(req, options.baseUrl)) {
    req.resume();
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("forbidden\n");
    return;
  }
  const form = await readForm(req);
  if (!form) {
    res.writeHead(413, { "Content-Type": "text/plain; charset=utf-8" }).end("too large\n");
    return;
  }

  const back = safeMailBack(form.get("back"));
  const list = safeMailBack(form.get("list"));
  const action = MAIL_ACTIONS.find((a) => a === form.get("action"));
  const ids = [...new Set(form.getAll("id").filter(isMessageId))].slice(0, MAX_BATCH);
  const labelRaw = form.get("label");
  const labelId = isLabelId(labelRaw) ? labelRaw : null;

  if (!action || ids.length === 0) {
    // 何も選ばずにボタンを押した。エラーにはせず、そのまま戻す。
    redirect(res, back);
    return;
  }
  if ((action === "label-add" || action === "label-remove") && !labelId) {
    redirect(res, withParams(back, { error: "failed" }));
    return;
  }

  const mailbox = await openMailbox(session, deps);
  if (!mailbox.ok) {
    redirect(res, withParams(back, { error: mailbox.kind }));
    return;
  }
  const result = await mailbox.inbox.apply(ids, action, labelId);
  if (!result.ok) {
    logFailure(`action:${action}`, result.kind, result.reason);
    redirect(res, withParams(back, { error: result.reason === CROSS_ACCOUNT_REASON ? "cross_account" : result.kind }));
    return;
  }
  const destination = form.has("list") && LEAVES_LIST.has(action) ? list : back;
  redirect(res, withParams(destination, { done: action, n: String(ids.length) }));
}
