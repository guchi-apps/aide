import { fetchAccessToken, type GmailCredentials } from "../image-mail/gmail.ts";
import { toDetail, toSummary, type GmailApiMessage, type MailDetail, type MailSummary } from "./message.ts";

/**
 * Morrow向けメールAPI（`/api/mail/*`。#770・#795）のための Gmail 読み取り・整理。
 *
 * **送信用（`AIDE_GMAIL_REFRESH_TOKEN`・`gmail.send`）とは別のリフレッシュトークンを使う。**
 * README「書き込みをどこまで持つか」の条件2（読み取りとは別の資格情報）に合わせ、送信の資格情報へ
 * 読み取り・整理の力を足さない。OAuthクライアント（`AIDE_GMAIL_CLIENT_ID`・`AIDE_GMAIL_CLIENT_SECRET`）
 * だけを共用する。トークンのスコープは `gmail.modify`（restricted）を想定している。
 *
 * **持つ操作はGmail上で元に戻せるものだけ**（ラベルの付け外し＝既読/未読・アーカイブ・スター、
 * ゴミ箱への移動と戻し）。完全削除（`messages.delete`）・送信・下書きは持たない。
 *
 * **メール本文は保存しない。** 開くたびにGmail APIを叩き、`data/`・キャッシュ・ログには書かない。
 * localhost並みとはいかないが数百ミリ秒のHTTPで、README「どこまでを重い取得とみなすか」の
 * 「都度叩く」側にあたる。
 *
 * `googleapis` 等のSDKは入れず、`fetch` だけで実装する（依存ゼロの方針）。
 */

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const REQUEST_TIMEOUT_MS = 15_000;
/** 一覧の1ページの件数。1件ごとにメタデータを取りに行くため、多くしすぎない。 */
export const PAGE_SIZE = 25;
/** 一覧のメタデータ取得を同時に何本まで走らせるか。Gmail APIのユーザー単位の上限に当てないため。 */
const METADATA_CONCURRENCY = 8;
/** 一括操作で受け付ける件数の上限。`batchModify` の上限（1000）よりずっと小さく、画面の1ページ分で足りる。 */
export const MAX_BATCH = 100;

export function loadGmailInboxCredentials(): GmailCredentials | null {
  const clientId = (process.env["AIDE_GMAIL_CLIENT_ID"] ?? "").trim();
  const clientSecret = (process.env["AIDE_GMAIL_CLIENT_SECRET"] ?? "").trim();
  const refreshToken = (process.env["AIDE_GMAIL_INBOX_REFRESH_TOKEN"] ?? "").trim();
  if (!clientId || !clientSecret || !refreshToken) return null;
  return { clientId, clientSecret, refreshToken };
}

export type GmailFailureKind = "unconfigured" | "unauthorized" | "not_found" | "failed";

export type GmailResult<T> = { ok: true; value: T } | { ok: false; kind: GmailFailureKind; reason: string };

export interface GmailLabel {
  id: string;
  name: string;
  type: "system" | "user";
}

export interface ListQuery {
  labelIds: string[];
  q: string;
  pageToken: string | null;
  includeSpamTrash: boolean;
  /** 複数アカウントのときに、読むアカウントの鍵を絞る（#794）。省略は全アカウント。 */
  account?: string | null;
}

export interface MailPage {
  messages: MailSummary[];
  /** 複数アカウントのとき、読めなかったアカウントの名前（#794）。 */
  failedAccounts?: string[];
  /** 複数アカウントのとき、全アカウント（メイン含む）の鍵・名前と、今回の取得で読めなかったか（#821）。 */
  accounts?: { key: string; name: string; failed: boolean }[];
  nextPageToken: string | null;
  /** Gmailの推定件数。正確ではない。 */
  resultSizeEstimate: number;
}

export type MailAction =
  | "read"
  | "unread"
  | "archive"
  | "inbox"
  | "star"
  | "unstar"
  | "trash"
  | "untrash"
  | "label-add"
  | "label-remove";

export const MAIL_ACTIONS: readonly MailAction[] = [
  "read",
  "unread",
  "archive",
  "inbox",
  "star",
  "unstar",
  "trash",
  "untrash",
  "label-add",
  "label-remove",
];

/** ラベルの付け外しで表せる操作を、追加・削除するラベルIDへ写す。ゴミ箱の出し入れは専用APIなので null。 */
export function labelChangeFor(
  action: MailAction,
  labelId: string | null,
): { addLabelIds: string[]; removeLabelIds: string[] } | null {
  switch (action) {
    case "read":
      return { addLabelIds: [], removeLabelIds: ["UNREAD"] };
    case "unread":
      return { addLabelIds: ["UNREAD"], removeLabelIds: [] };
    case "archive":
      return { addLabelIds: [], removeLabelIds: ["INBOX"] };
    case "inbox":
      return { addLabelIds: ["INBOX"], removeLabelIds: [] };
    case "star":
      return { addLabelIds: ["STARRED"], removeLabelIds: [] };
    case "unstar":
      return { addLabelIds: [], removeLabelIds: ["STARRED"] };
    case "label-add":
      return labelId ? { addLabelIds: [labelId], removeLabelIds: [] } : null;
    case "label-remove":
      return labelId ? { addLabelIds: [], removeLabelIds: [labelId] } : null;
    case "trash":
    case "untrash":
      return null;
  }
}

/**
 * メールAPI（`src/api/mail.ts`）が使う取得元の共通の形。Gmail API（`GmailInbox`）とIMAP
 * （`imap-inbox/client.ts`の`ImapInbox`。#782）が実装する。APIはどちらか1つだけを使う。
 */
export interface MailInbox {
  readonly kind: "gmail" | "imap";
  /** ラベルの付け外しを持つか。IMAPには無いので、画面はラベルの操作を出さない。 */
  readonly supportsLabels: boolean;
  /** 複数アカウントを束ねているときの一覧（#794）。1アカウントなら無い。 */
  readonly accounts?: readonly { key: string; name: string }[];
  profileEmail(): Promise<GmailResult<string>>;
  labels(): Promise<GmailResult<GmailLabel[]>>;
  list(query: ListQuery): Promise<GmailResult<MailPage>>;
  get(id: string): Promise<GmailResult<MailDetail>>;
  apply(ids: string[], action: MailAction, labelId: string | null): Promise<GmailResult<void>>;
}

export interface GmailInboxDeps {
  fetchImpl?: typeof fetch;
  credentials?: GmailCredentials | null;
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const parsed = JSON.parse(await response.text()) as { error?: { message?: unknown } };
    const message = parsed.error?.message;
    return typeof message === "string" && message ? `: ${message.slice(0, 200)}` : "";
  } catch {
    return "";
  }
}

/** 1リクエスト（画面の1回の表示・1回の操作）の間だけ使うクライアント。アクセストークンはその間だけ持つ。 */
export class GmailInbox implements MailInbox {
  readonly kind = "gmail" as const;
  readonly supportsLabels = true;
  private readonly fetchImpl: typeof fetch;
  private readonly accessToken: string;

  private constructor(fetchImpl: typeof fetch, accessToken: string) {
    this.fetchImpl = fetchImpl;
    this.accessToken = accessToken;
  }

  static async connect(deps: GmailInboxDeps = {}): Promise<GmailResult<GmailInbox>> {
    const credentials = deps.credentials === undefined ? loadGmailInboxCredentials() : deps.credentials;
    if (!credentials) {
      return { ok: false, kind: "unconfigured", reason: "Gmailの読み取り用の資格情報が設定されていません" };
    }
    const fetchImpl = deps.fetchImpl ?? fetch;
    const token = await fetchAccessToken(credentials, fetchImpl);
    if (!token.ok) return { ok: false, kind: token.kind, reason: token.reason };
    return { ok: true, value: new GmailInbox(fetchImpl, token.accessToken) };
  }

  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown; withDetail?: boolean } = {},
  ): Promise<GmailResult<T>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(`${API}${path}`, {
        method: init.method ?? "GET",
        headers: {
          authorization: `Bearer ${this.accessToken}`,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const kind: GmailFailureKind =
          response.status === 401 || response.status === 403
            ? "unauthorized"
            : response.status === 404
              ? "not_found"
              : "failed";
        // 失敗の理由（Pub/Subの権限不足など）が要る呼び出しだけ、Googleが返したメッセージを添える。
        // 本文はメールの内容を含まないエラー応答なので、ログに残してよい。
        const detail = init.withDetail ? await readErrorMessage(response) : "";
        return { ok: false, kind, reason: `Gmail APIがエラーを返しました（${response.status}）${detail}` };
      }
      // batchModify は本文の無い 204 を返す。
      if (response.status === 204) return { ok: true, value: undefined as T };
      const text = await response.text();
      return { ok: true, value: (text ? JSON.parse(text) : undefined) as T };
    } catch (cause) {
      const aborted = cause instanceof Error && cause.name === "AbortError";
      return {
        ok: false,
        kind: "failed",
        reason: aborted ? "Gmail APIがタイムアウトしました" : "Gmail APIへ接続できませんでした",
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** 認可したGmailアカウントのメールアドレス。持ち主のメールアドレスとして応答に載せ、Morrow側で本人かを照合するのに使う。 */
  async profileEmail(): Promise<GmailResult<string>> {
    const result = await this.request<{ emailAddress?: string }>("/profile");
    if (!result.ok) return result;
    const email = result.value?.emailAddress;
    if (typeof email !== "string" || !email) {
      return { ok: false, kind: "failed", reason: "Gmailのプロフィール応答が不正です" };
    }
    return { ok: true, value: email };
  }

  /**
   * 受信トレイの変更をPub/Subのトピックへ通知させる（`users.watch`。#829）。
   * 期限は7日（応答の `expiration`＝ミリ秒のエポック）なので、呼び出し側が毎日かけ直す。
   * 同じ内容でかけ直しても上書きされるだけで害はない。
   */
  async watch(topicName: string): Promise<GmailResult<{ historyId: string; expiration: string }>> {
    const result = await this.request<{ historyId?: string; expiration?: string }>("/watch", {
      method: "POST",
      body: { labelIds: ["INBOX"], labelFilterBehavior: "INCLUDE", topicName },
      withDetail: true,
    });
    if (!result.ok) return result;
    const { historyId, expiration } = result.value ?? {};
    if (typeof historyId !== "string" || typeof expiration !== "string") {
      return { ok: false, kind: "failed", reason: "Gmailのwatch応答が不正です" };
    }
    return { ok: true, value: { historyId, expiration } };
  }

  async labels(): Promise<GmailResult<GmailLabel[]>> {
    const result = await this.request<{ labels?: { id: string; name: string; type?: string }[] }>("/labels");
    if (!result.ok) return result;
    const labels = (result.value?.labels ?? []).map((label) => ({
      id: label.id,
      name: label.name,
      type: label.type === "user" ? ("user" as const) : ("system" as const),
    }));
    return { ok: true, value: labels };
  }

  async list(query: ListQuery): Promise<GmailResult<MailPage>> {
    const params = new URLSearchParams({ maxResults: String(PAGE_SIZE) });
    for (const id of query.labelIds) params.append("labelIds", id);
    if (query.q) params.set("q", query.q);
    if (query.pageToken) params.set("pageToken", query.pageToken);
    if (query.includeSpamTrash) params.set("includeSpamTrash", "true");

    const listed = await this.request<{
      messages?: { id: string }[];
      nextPageToken?: string;
      resultSizeEstimate?: number;
    }>(`/messages?${params}`);
    if (!listed.ok) return listed;

    const ids = (listed.value?.messages ?? []).map((m) => m.id);
    const summaries: (MailSummary | null)[] = new Array(ids.length).fill(null);
    let failure: GmailResult<never> | null = null;
    let next = 0;
    const worker = async () => {
      while (next < ids.length && !failure) {
        const index = next++;
        const result = await this.request<GmailApiMessage>(
          `/messages/${encodeURIComponent(ids[index]!)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
        );
        if (result.ok) summaries[index] = toSummary(result.value);
        // 一覧を取ってからメタデータを取るまでに消えたメールは、黙って飛ばす。
        else if (result.kind !== "not_found") failure = result;
      }
    };
    await Promise.all(Array.from({ length: Math.min(METADATA_CONCURRENCY, ids.length) }, worker));
    if (failure) return failure;

    return {
      ok: true,
      value: {
        messages: summaries.filter((s): s is MailSummary => s !== null),
        nextPageToken: listed.value?.nextPageToken ?? null,
        resultSizeEstimate: listed.value?.resultSizeEstimate ?? 0,
      },
    };
  }

  async get(id: string): Promise<GmailResult<MailDetail>> {
    const result = await this.request<GmailApiMessage>(`/messages/${encodeURIComponent(id)}?format=full`);
    if (!result.ok) return result;
    return { ok: true, value: toDetail(result.value) };
  }

  /** 操作を適用する。ゴミ箱の出し入れは1件ずつ、それ以外は `batchModify` 1回で済ませる。 */
  async apply(ids: string[], action: MailAction, labelId: string | null): Promise<GmailResult<void>> {
    if (ids.length === 0) return { ok: true, value: undefined };
    if (action === "trash" || action === "untrash") {
      for (const id of ids) {
        const result = await this.request<unknown>(`/messages/${encodeURIComponent(id)}/${action}`, {
          method: "POST",
        });
        if (!result.ok) return result;
      }
      return { ok: true, value: undefined };
    }
    const change = labelChangeFor(action, labelId);
    if (!change) return { ok: false, kind: "failed", reason: "ラベルが指定されていません" };
    const result = await this.request<unknown>("/messages/batchModify", {
      method: "POST",
      body: { ids, ...change },
    });
    return result.ok ? { ok: true, value: undefined } : result;
  }
}
