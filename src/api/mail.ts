import type { IncomingMessage, ServerResponse } from "node:http";
import { clientKey, FAILURE_DELAY_MS, lockedFor, recordFailure, recordSuccess } from "../auth/ratelimit.ts";
import {
  GmailInbox,
  loadGmailInboxCredentials,
  MAIL_ACTIONS,
  MAX_BATCH,
  type GmailFailureKind,
  type GmailInboxDeps,
  type GmailResult,
  type ListQuery,
  type MailAction,
  type MailInbox,
} from "../core/connectors/gmail-inbox/client.ts";
import { ImapInbox, loadImapCredentials, type ImapInboxDeps } from "../core/connectors/imap-inbox/client.ts";
import { getSharedToken } from "../core/connectors/issue-deck/shared-tokens.ts";
import { CROSS_ACCOUNT_REASON, loadExtraMailAccounts, MultiMailInbox, type ExtraMailAccount } from "../core/connectors/mail-accounts.ts";
import { bearerToken, secretMatches } from "./secret.ts";

/**
 * Morrow（`guchi-apps/morrow`）向けのメール読み取り・整理API（#795）。
 *
 * メール画面と「必要なメールのお知らせ」はMorrowへ移すが、**Gmail/IMAPの資格情報と取得処理は
 * AIDEに残す**（資格情報を1か所に閉じ込めるため。画像メール #230 と同じ考え方）。Morrowの**サーバー**が
 * ここを叩き、画面の描画・通知の要否判定はMorrow側で行う。取得元（Gmail / IMAP）は
 * `selectMailSource()`・`connectMailbox()` を通す。
 *
 * - `GET  /api/mail/messages?view=&label=&q=&page=&since=` — 一覧（1ページ分）。`since`（UNIX時刻・ミリ秒）を
 *   付けると、そのページのうち受信がそれ以降のものだけを返す（新着の確認用。ページをまたいでは探さない）
 * - `GET  /api/mail/messages/<id>` — 本文1件
 * - `POST /api/mail/actions` — `{ "action": "...", "ids": ["..."], "labelId": "..." }`。持つ操作は
 *   **元に戻せるものだけ**（既読/未読・アーカイブ・受信トレイへ戻す・スター・ラベル・ゴミ箱の出し入れ）
 *
 * **一覧は一部のアカウントが読めなくても200で返すが、`partial: true` と `failedAccounts`（アカウント名）を載せる。**
 * `partial` のとき `messages` には欠落がある。Morrowは巡回の成功記録（既読位置など）を進めず、次回に再取得する。
 * 複数アカウントの構成では `accounts: [{ key, name, failed }]`（メインを含む全件）も載せる（#821）。
 *
 * **応答には持ち主のメールアドレス（`owner`）を載せる。** トークンが表すのは「Morrowのサーバー」で利用者ではない
 * ため、ログイン中の人がメールボックスの持ち主本人かどうかの照合はMorrow側が `owner` で行う。
 *
 * 認証は専用の共有シークレット `AIDE_MAIL_API_TOKEN`（issue-deckの共有トークン。取れなければ環境変数）。
 * 他の口のトークンとは共用しない。未設定なら503で閉じる。**本文・件名・差出人はログに出さない。**
 * MCPツールには出さない（README「Gmailを載せていない理由」の判断はMCP層について据え置き）。
 */

// ---- 取得元・一覧の条件（旧メール画面 `src/web/mail.ts` から移した。画面は #798 で廃止） ----

/** 取得元の種類（#782）。 */
export type MailSource = "gmail" | "imap";

/** 取得元の失敗の種類。 */
export type MailFailure = GmailFailureKind;

/** 一覧のビュー。`labelIds` はGmail APIの `labelIds`（AND条件）にそのまま渡す。 */
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
 * メッセージ ID。Gmailは16進、IMAPは `<フォルダ(base64url)>.<UIDVALIDITY>.<UID>`（#782）なので、
 * 英数字・`_`・`-`・`.` の範囲で受ける。
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

export interface MailDeps extends GmailInboxDeps {
  connect?: (deps: GmailInboxDeps) => Promise<GmailResult<MailInbox>>;
  /** IMAPの取得元の差し替え（テスト用）。 */
  imap?: ImapInboxDeps;
  /** 取得元の指定（テスト用）。省略時は環境変数から決める。 */
  source?: MailSource;
  /** 追加アカウントの指定（テスト用）。省略時は `AIDE_MAIL_ACCOUNTS` から読む（#794）。 */
  extraAccounts?: ExtraMailAccount[];
}

/**
 * 読む取得元を決める（#782）。**1つの環境では1つだけ**。
 * `AIDE_MAIL_SOURCE`（`gmail` / `imap`）で明示でき、省略時はGmailの読み取り用トークンがあればGmail、
 * 無くてIMAPの接続情報があればIMAP、どちらも無ければGmail（未設定として扱う）。
 */
export function selectMailSource(): MailSource {
  const explicit = (process.env["AIDE_MAIL_SOURCE"] ?? "").trim().toLowerCase();
  if (explicit === "gmail" || explicit === "imap") return explicit;
  if (loadGmailInboxCredentials()) return "gmail";
  return loadImapCredentials() ? "imap" : "gmail";
}

async function connectMain(deps: MailDeps): Promise<GmailResult<MailInbox>> {
  if (deps.connect) return deps.connect(deps);
  if ((deps.source ?? selectMailSource()) === "imap") return ImapInbox.connect(deps.imap ?? {});
  return GmailInbox.connect(deps);
}

/** メインの取得元に、追加アカウントがあれば束ねる（#794）。無ければメインだけ。 */
async function connect(deps: MailDeps): Promise<GmailResult<MailInbox>> {
  const main = await connectMain(deps);
  if (!main.ok) return main;
  const extras = deps.extraAccounts ?? loadExtraMailAccounts();
  if (extras.length === 0) return main;
  return MultiMailInbox.connect(main.value, extras, deps.imap ?? {});
}

export function logMailFailure(where: string, kind: MailFailure, reason: string): void {
  // 件名・差出人・本文・IDは出さない。失敗の種類と理由（ステータスコード程度）だけ。
  if (kind !== "unconfigured") console.warn(`[mail] ${where}: ${kind} ${reason}`);
}

/**
 * 取得元へつなぎ、メールボックスの持ち主のメールアドレス（Gmailは `users.getProfile`、IMAPは
 * `AIDE_IMAP_OWNER_EMAIL` など。複数のアカウントを束ねるときはメインのアカウント）を引く。
 * 持ち主との照合は呼び出し元（Morrow）が応答の `owner` で行う。
 */
export async function connectMailbox(
  deps: MailDeps,
): Promise<{ ok: true; inbox: MailInbox; owner: string } | { ok: false; kind: MailFailure }> {
  const inbox = await connect(deps);
  if (!inbox.ok) {
    logMailFailure("connect", inbox.kind, inbox.reason);
    return { ok: false, kind: inbox.kind };
  }
  const profile = await inbox.value.profileEmail();
  if (!profile.ok) {
    logMailFailure("profile", profile.kind, profile.reason);
    return { ok: false, kind: profile.kind };
  }
  return { ok: true, inbox: inbox.value, owner: profile.value.trim().toLowerCase() };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res
    .writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
    .end(JSON.stringify(body));
}

export async function mailApiToken(): Promise<string | null> {
  const shared = await getSharedToken("AIDE_MAIL_API_TOKEN", "aide");
  if (shared) return shared;
  return process.env["AIDE_MAIL_API_TOKEN"] || null;
}

export interface MailApiDeps extends MailDeps {
  token?: () => Promise<string | null>;
  /** 認証失敗時の遅延（テストでは0にする）。 */
  failureDelayMs?: number;
}

async function authorize(req: IncomingMessage, res: ServerResponse, deps: MailApiDeps): Promise<boolean> {
  const expected = await (deps.token ?? mailApiToken)();
  if (!expected) {
    json(res, 503, { ok: false, error: "unconfigured", message: "AIDE_MAIL_API_TOKEN が未設定のため利用できません" });
    return false;
  }
  const key = `mail-api:${clientKey(req)}`;
  const locked = lockedFor(key);
  if (locked !== null) {
    json(res, 429, { ok: false, error: "locked", message: `試行回数の上限に達しています。${locked}秒後に再試行してください` });
    return false;
  }
  const presented = bearerToken(req);
  if (!presented || !secretMatches(presented, expected)) {
    recordFailure(key);
    console.warn(`[mail-api] 認証失敗: ${req.method} from=${key}`);
    await new Promise((resolve) => setTimeout(resolve, deps.failureDelayMs ?? FAILURE_DELAY_MS));
    json(res, 401, { ok: false, error: "unauthorized", message: "unauthorized" });
    return false;
  }
  recordSuccess(key);
  return true;
}

/** 取得元の失敗を応答へ写す。`not_found` 以外は呼び出し元の誤りではないので5xx。 */
function failure(res: ServerResponse, kind: MailFailure): void {
  const status = kind === "not_found" ? 404 : kind === "unconfigured" ? 503 : 502;
  json(res, status, { ok: false, error: kind });
}

/** `/api/mail/messages/<id>` のIDを取り出す。形が違えば null。 */
export function messageIdFromPath(path: string): string | null {
  const match = /^\/api\/mail\/messages\/([^/]+)$/.exec(path);
  if (!match) return null;
  let id: string;
  try {
    id = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  return isMessageId(id) ? id : null;
}

export async function handleMailApiList(req: IncomingMessage, res: ServerResponse, deps: MailApiDeps = {}): Promise<void> {
  if (!(await authorize(req, res, deps))) return;
  const params = new URL(req.url ?? "/", "http://localhost").searchParams;
  const state = parseListState(params);
  const sinceRaw = params.get("since");
  const since = sinceRaw && /^\d{1,15}$/.test(sinceRaw) ? Number(sinceRaw) : null;

  const mailbox = await connectMailbox(deps);
  if (!mailbox.ok) return failure(res, mailbox.kind);
  const [labels, page] = await Promise.all([mailbox.inbox.labels(), mailbox.inbox.list(toListQuery(state))]);
  if (!page.ok) {
    logMailFailure("api:list", page.kind, page.reason);
    return failure(res, page.kind);
  }
  const messages =
    since === null ? page.value.messages : page.value.messages.filter((m) => m.receivedAt !== null && m.receivedAt >= since);
  const failedAccounts = page.value.failedAccounts ?? [];
  json(res, 200, {
    ok: true,
    source: deps.source ?? selectMailSource(),
    owner: mailbox.owner,
    supportsLabels: mailbox.inbox.supportsLabels,
    // 一部のアカウントが読めなかったときは partial: true。欠落があるので、Morrowは巡回の成功記録を進めず再試行する（#801）。
    partial: failedAccounts.length > 0,
    failedAccounts,
    // 複数アカウントの構成のみ。タブの元にできるよう、鍵・名前・今回読めなかったかを返す（#821）。
    ...(page.value.accounts ? { accounts: page.value.accounts } : {}),
    view: state.view.key,
    labels: labels.ok ? labels.value : [],
    messages,
    nextPageToken: page.value.nextPageToken,
    resultSizeEstimate: page.value.resultSizeEstimate,
  });
}

export async function handleMailApiMessage(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: MailApiDeps = {},
): Promise<void> {
  if (!(await authorize(req, res, deps))) return;
  const id = messageIdFromPath(path);
  if (!id) return json(res, 404, { ok: false, error: "not_found" });
  const mailbox = await connectMailbox(deps);
  if (!mailbox.ok) return failure(res, mailbox.kind);
  const message = await mailbox.inbox.get(id);
  if (!message.ok) {
    logMailFailure("api:get", message.kind, message.reason);
    return failure(res, message.kind);
  }
  json(res, 200, {
    ok: true,
    source: deps.source ?? selectMailSource(),
    owner: mailbox.owner,
    supportsLabels: mailbox.inbox.supportsLabels,
    message: message.value,
  });
}

/** 操作のリクエスト本文の上限。IDを `MAX_BATCH` 件並べても収まる大きさ。 */
const MAX_ACTION_BYTES = 64 * 1024;

export type ParsedAction = { action: MailAction; ids: string[]; labelId: string | null } | { error: string };

export function parseActionBody(body: unknown): ParsedAction {
  if (typeof body !== "object" || body === null) return { error: "リクエストボディが不正です" };
  const record = body as Record<string, unknown>;
  const action = MAIL_ACTIONS.find((a) => a === record["action"]);
  if (!action) return { error: "action が不正です" };
  const rawIds = record["ids"];
  if (!Array.isArray(rawIds) || rawIds.length === 0) return { error: "ids は1件以上の配列で指定してください" };
  if (rawIds.length > MAX_BATCH) return { error: `ids は ${MAX_BATCH} 件以内で指定してください` };
  if (!rawIds.every((id) => isMessageId(id as string))) return { error: "ids に不正なIDが含まれています" };
  const ids = [...new Set(rawIds as string[])];
  const rawLabel = record["labelId"];
  const labelId = isLabelId(rawLabel as string) ? (rawLabel as string) : null;
  if ((action === "label-add" || action === "label-remove") && !labelId) return { error: "labelId が必要です" };
  return { action, ids, labelId };
}

export async function handleMailApiAction(req: IncomingMessage, res: ServerResponse, deps: MailApiDeps = {}): Promise<void> {
  if (!(await authorize(req, res, deps))) {
    req.resume();
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_ACTION_BYTES) return json(res, 413, { ok: false, error: "too_large" });
    chunks.push(chunk as Buffer);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return json(res, 400, { ok: false, error: "invalid_json" });
  }
  const parsed = parseActionBody(body);
  if ("error" in parsed) return json(res, 400, { ok: false, error: "invalid_request", message: parsed.error });
  const mailbox = await connectMailbox(deps);
  if (!mailbox.ok) return failure(res, mailbox.kind);
  if (!mailbox.inbox.supportsLabels && (parsed.action === "label-add" || parsed.action === "label-remove")) {
    return json(res, 400, { ok: false, error: "invalid_request", message: "この取得元はラベルを扱えません" });
  }
  const result = await mailbox.inbox.apply(parsed.ids, parsed.action, parsed.labelId);
  if (!result.ok) {
    if (result.reason === CROSS_ACCOUNT_REASON) {
      return json(res, 400, { ok: false, error: "invalid_request", message: result.reason });
    }
    logMailFailure(`api:action:${parsed.action}`, result.kind, result.reason);
    return failure(res, result.kind);
  }
  json(res, 200, { ok: true, owner: mailbox.owner, action: parsed.action, count: parsed.ids.length });
}
