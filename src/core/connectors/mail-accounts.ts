import type {
  GmailLabel,
  GmailResult,
  ListQuery,
  MailAction,
  MailInbox,
  MailPage,
} from "./gmail-inbox/client.ts";
import type { MailDetail, MailSummary } from "./gmail-inbox/message.ts";
import { ImapInbox, type ImapCredentials, type ImapInboxDeps } from "./imap-inbox/client.ts";

/**
 * 複数のメールアカウントを1つの受信トレイとして見せる取得元（#794）。
 *
 * メインのアカウント（従来の `AIDE_IMAP_*` またはGmailのトークン）に、`AIDE_MAIL_ACCOUNTS` に書いた
 * IMAPのアカウントを足す。追加アカウントが無い環境では使わない（画面は従来の1アカウントのまま）。
 *
 * **ID の表し方。** メッセージID・ラベルIDの先頭に `<アカウントの鍵>~` を付け、操作はその鍵のアカウントへ
 * 振り分ける。鍵は英小文字・数字だけ（`main` はメイン用に予約）。
 * **ページ送り。** 各アカウントの次ページの位置を1つのトークン（JSONのbase64url）にまとめる。
 * 1ページは「各アカウント1ページ分」を日付の新しい順に混ぜたもの。
 * **メール本文・パスワードは保存しない。** ログにはアカウント名と失敗の種類だけを出す。
 */

export const MAIN_ACCOUNT_KEY = "main";
const KEY_PATTERN = /^[a-z0-9]{1,12}$/;
const MAX_EXTRA_ACCOUNTS = 5;
const SEPARATOR = "~";

export interface MailAccountInfo {
  key: string;
  /** 画面に出す名前。 */
  name: string;
}

export interface ExtraMailAccount extends MailAccountInfo {
  credentials: ImapCredentials;
}

/**
 * `AIDE_MAIL_ACCOUNTS`（JSON配列）を読む。
 * 例: `[{"name":"sub","label":"サブ","host":"imap.gmail.com","user":"sub@example.com","password":"...","port":993}]`
 * 不正な要素は読み飛ばす（パスワード等を含みうるので、ログに内容は出さない）。
 */
export function loadExtraMailAccounts(raw: string | undefined = process.env["AIDE_MAIL_ACCOUNTS"]): ExtraMailAccount[] {
  const text = (raw ?? "").trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.warn("[mail] AIDE_MAIL_ACCOUNTS がJSONとして読めないため、追加アカウントを使いません");
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const accounts: ExtraMailAccount[] = [];
  const seen = new Set<string>([MAIN_ACCOUNT_KEY]);
  for (const item of parsed) {
    if (accounts.length >= MAX_EXTRA_ACCOUNTS) break;
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const key = str(o["name"]);
    const host = str(o["host"]);
    const user = str(o["user"]);
    const password = typeof o["password"] === "string" ? o["password"] : "";
    if (!KEY_PATTERN.test(key) || seen.has(key) || !host || !user || !password) continue;
    const port = typeof o["port"] === "number" && Number.isInteger(o["port"]) && o["port"] > 0 && o["port"] < 65536 ? o["port"] : 993;
    seen.add(key);
    accounts.push({
      key,
      name: str(o["label"]).slice(0, 20) || key,
      credentials: { host, port, user, password, ownerEmail: null },
    });
  }
  return accounts;
}

export function prefixId(key: string, id: string): string {
  return `${key}${SEPARATOR}${id}`;
}

export function splitId(id: string): { key: string; rest: string } | null {
  const index = id.indexOf(SEPARATOR);
  if (index <= 0) return null;
  const key = id.slice(0, index);
  const rest = id.slice(index + 1);
  return KEY_PATTERN.test(key) && rest ? { key, rest } : null;
}

/** Gmailのシステムラベル（`INBOX`・`CATEGORY_SOCIAL` など）は全アカウント共通なので接頭辞を付けない。 */
const isSystemLabel = (id: string) => /^[A-Z_]+$/.test(id);

function encodeToken(tokens: Record<string, string>): string | null {
  return Object.keys(tokens).length ? Buffer.from(JSON.stringify(tokens), "utf8").toString("base64url") : null;
}

function decodeToken(token: string | null): Record<string, string> | null {
  if (!token) return {};
  try {
    const value: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(value)) if (KEY_PATTERN.test(k) && typeof v === "string") out[k] = v;
    return out;
  } catch {
    return null;
  }
}

interface Member {
  info: MailAccountInfo;
  inbox: MailInbox;
}

export class MultiMailInbox implements MailInbox {
  readonly kind: "gmail" | "imap";
  readonly supportsLabels: boolean;
  readonly accounts: readonly MailAccountInfo[];
  private readonly members: Member[];

  constructor(members: Member[]) {
    this.members = members;
    this.kind = members[0]!.inbox.kind;
    this.supportsLabels = members.some((m) => m.inbox.supportsLabels);
    this.accounts = members.map((m) => m.info);
  }

  /** メイン（持ち主の確認に使う）に、追加アカウントのIMAPを束ねる。 */
  static async connect(
    main: MailInbox,
    extras: ExtraMailAccount[],
    imap: ImapInboxDeps = {},
  ): Promise<GmailResult<MultiMailInbox>> {
    const members: Member[] = [{ info: { key: MAIN_ACCOUNT_KEY, name: "メイン" }, inbox: main }];
    for (const extra of extras) {
      const inbox = await ImapInbox.connect({ ...imap, credentials: extra.credentials });
      if (!inbox.ok) continue;
      members.push({ info: { key: extra.key, name: extra.name }, inbox: inbox.value });
    }
    return { ok: true, value: new MultiMailInbox(members) };
  }

  private find(key: string): Member | undefined {
    return this.members.find((m) => m.info.key === key);
  }

  /** 持ち主の確認はメインのアカウントだけで行う（追加アカウントは別のアドレスなので一致しない）。 */
  profileEmail(): Promise<GmailResult<string>> {
    return this.members[0]!.inbox.profileEmail();
  }

  async labels(): Promise<GmailResult<GmailLabel[]>> {
    const results = await Promise.all(
      this.members.map(async (m) => ({ m, r: await m.inbox.labels() })),
    );
    const labels: GmailLabel[] = [];
    for (const { m, r } of results) {
      if (!r.ok) continue;
      for (const label of r.value) {
        if (label.type !== "user") continue;
        const multiple = this.members.length > 1;
        labels.push({
          id: prefixId(m.info.key, label.id),
          name: multiple ? `${m.info.name}: ${label.name}` : label.name,
          type: "user",
        });
      }
    }
    return { ok: true, value: labels };
  }

  async list(query: ListQuery): Promise<GmailResult<MailPage>> {
    // ラベル（フォルダ）で絞っているときは、そのアカウントだけを読む。
    const labelOwner = query.labelIds.map(splitId).find((s) => s !== null) ?? null;
    const targets = labelOwner
      ? this.members.filter((m) => m.info.key === labelOwner.key)
      : query.account
        ? this.members.filter((m) => m.info.key === query.account)
        : this.members;
    const tokens = decodeToken(query.pageToken);
    if (!tokens) return { ok: false, kind: "failed", reason: "ページ位置が不正です" };

    const results = await Promise.all(
      targets.map(async (m) => {
        const token = tokens[m.info.key] ?? null;
        // 2ページ目以降に来て、このアカウントの続きが無いなら読まない。
        if (query.pageToken && token === null) return { m, r: null };
        const labelIds = query.labelIds.map((id) => (splitId(id)?.key === m.info.key ? splitId(id)!.rest : id));
        return { m, r: await m.inbox.list({ ...query, labelIds, pageToken: token }) };
      }),
    );

    const messages: MailSummary[] = [];
    const next: Record<string, string> = {};
    const failedAccounts: string[] = [];
    let estimate = 0;
    let firstFailure: { kind: Extract<GmailResult<never>, { ok: false }>["kind"]; reason: string } | null = null;
    let anyOk = false;
    for (const { m, r } of results) {
      if (r === null) continue;
      if (!r.ok) {
        console.warn(`[mail] account:${m.info.key}: list ${r.kind} ${r.reason}`);
        failedAccounts.push(m.info.name);
        firstFailure ??= { kind: r.kind, reason: r.reason };
        continue;
      }
      anyOk = true;
      estimate += r.value.resultSizeEstimate;
      if (r.value.nextPageToken) next[m.info.key] = r.value.nextPageToken;
      for (const message of r.value.messages) {
        messages.push({
          ...message,
          id: prefixId(m.info.key, message.id),
          labelIds: message.labelIds.map((l) => (isSystemLabel(l) ? l : prefixId(m.info.key, l))),
          account: m.info.name,
        });
      }
    }
    if (!anyOk && firstFailure) return { ok: false, ...firstFailure };
    messages.sort((a, b) => (b.receivedAt ?? 0) - (a.receivedAt ?? 0));
    return {
      ok: true,
      value: {
        messages,
        nextPageToken: encodeToken(next),
        resultSizeEstimate: estimate,
        ...(failedAccounts.length ? { failedAccounts } : {}),
      },
    };
  }

  async get(id: string): Promise<GmailResult<MailDetail>> {
    const split = splitId(id);
    const member = split ? this.find(split.key) : undefined;
    if (!split || !member) return { ok: false, kind: "not_found", reason: "メールが見つかりません" };
    const result = await member.inbox.get(split.rest);
    if (!result.ok) return result;
    const detail = result.value;
    return {
      ok: true,
      value: {
        ...detail,
        id: prefixId(member.info.key, detail.id),
        labelIds: detail.labelIds.map((l) => (isSystemLabel(l) ? l : prefixId(member.info.key, l))),
        account: member.info.name,
      },
    };
  }

  async apply(ids: string[], action: MailAction, labelId: string | null): Promise<GmailResult<void>> {
    const byAccount = new Map<string, string[]>();
    for (const id of ids) {
      const split = splitId(id);
      if (!split || !this.find(split.key)) return { ok: false, kind: "not_found", reason: "メールが見つかりません" };
      byAccount.set(split.key, [...(byAccount.get(split.key) ?? []), split.rest]);
    }
    const label = labelId ? splitId(labelId) : null;
    for (const [key, rests] of byAccount) {
      const member = this.find(key)!;
      // ラベルは持ち主のアカウントのものだけを付け外しできる。
      const own = label && label.key === key ? label.rest : null;
      if ((action === "label-add" || action === "label-remove") && !own) {
        return { ok: false, kind: "failed", reason: "別のアカウントのラベルは付け外しできません" };
      }
      const result = await member.inbox.apply(rests, action, own);
      if (!result.ok) return result;
    }
    return { ok: true, value: undefined };
  }
}
