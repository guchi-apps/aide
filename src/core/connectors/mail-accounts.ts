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

/** 複数アカウントにまたがる操作を拒否したときの理由。呼出元が「接続失敗」と区別して案内するのに使う（#810）。 */
export const CROSS_ACCOUNT_REASON = "複数のアカウントのメールは同時に操作できません。アカウントごとに選び直してください";

export interface MailAccountInfo {
  key: string;
  /** 画面に出す名前。 */
  name: string;
}

export interface ExtraMailAccount extends MailAccountInfo {
  credentials: ImapCredentials;
}

/**
 * `AIDE_MAIL_ACCOUNTS` を読む。値はJSON配列を **base64url に符号化した1行**。
 * デプロイのgateが書く `.env` は `"` を含む値を正しく扱えないため、JSONそのままでは本番に渡せない。
 * `[` で始まる値は符号化していないJSONとして読む（手元の確認用）。
 * JSON配列の例: `[{"name":"sub","label":"サブ","host":"imap.gmail.com","user":"sub@example.com","password":"...","port":993}]`
 * 不正な要素は読み飛ばす（パスワード等を含みうるので、ログに内容は出さない）。
 */
export function loadExtraMailAccounts(raw: string | undefined = process.env["AIDE_MAIL_ACCOUNTS"]): ExtraMailAccount[] {
  const text = (raw ?? "").trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.startsWith("[") ? text : Buffer.from(text, "base64url").toString("utf8"));
  } catch {
    console.warn("[mail] AIDE_MAIL_ACCOUNTS がbase64url符号化したJSONとして読めないため、追加アカウントを使いません");
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const accounts: ExtraMailAccount[] = [];
  const seen = new Set<string>([MAIN_ACCOUNT_KEY]);
  for (const item of parsed) {
    if (accounts.length >= MAX_EXTRA_ACCOUNTS) {
      console.warn(`[mail] AIDE_MAIL_ACCOUNTS は最大${MAX_EXTRA_ACCOUNTS}件までのため、超えた分を使いません`);
      break;
    }
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
  /** 接続できなかった追加アカウント。一覧では「読めなかったアカウント」として必ず報告する（#801）。 */
  private readonly unreachable: MailAccountInfo[];

  constructor(members: Member[], unreachable: MailAccountInfo[] = []) {
    this.members = members;
    this.unreachable = unreachable;
    this.kind = members[0]!.inbox.kind;
    this.supportsLabels = members.some((m) => m.inbox.supportsLabels);
    this.accounts = [...members.map((m) => m.info), ...unreachable];
  }

  /** メイン（持ち主の確認に使う）に、追加アカウントのIMAPを束ねる。 */
  static async connect(
    main: MailInbox,
    extras: ExtraMailAccount[],
    imap: ImapInboxDeps = {},
  ): Promise<GmailResult<MultiMailInbox>> {
    const members: Member[] = [{ info: { key: MAIN_ACCOUNT_KEY, name: "メイン" }, inbox: main }];
    const unreachable: MailAccountInfo[] = [];
    for (const extra of extras) {
      const inbox = await ImapInbox.connect({ ...imap, credentials: extra.credentials });
      if (!inbox.ok) {
        console.warn(`[mail] account:${extra.key}: connect ${inbox.kind} ${inbox.reason}`);
        unreachable.push({ key: extra.key, name: extra.name });
        continue;
      }
      members.push({ info: { key: extra.key, name: extra.name }, inbox: inbox.value });
    }
    return { ok: true, value: new MultiMailInbox(members, unreachable) };
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
    // 接続できなかったアカウントも、読む対象に入っていれば失敗として数える。
    const unreachableTargets = this.unreachable.filter((u) =>
      labelOwner ? u.key === labelOwner.key : query.account ? u.key === query.account : true,
    );

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
    // 接続できなかったアカウントは、メインの一覧失敗の種類（kind）を隠さないよう最後に足す。
    for (const u of unreachableTargets) {
      failedAccounts.push(u.name);
      firstFailure ??= { kind: "failed", reason: "接続できません" };
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

  /**
   * 変更はアカウント単位でしか送れず、複数アカウントにまたがる操作は途中で失敗したときに先行アカウントだけが
   * 変更された状態になる（補償も内訳の返却もできない。#810）。そのため、1回の操作で選べるのは1アカウントのメール
   * だけとし、またがる選択は **1件も変更せず** 拒否する。検証はすべて変更の前に済ませる。
   */
  async apply(ids: string[], action: MailAction, labelId: string | null): Promise<GmailResult<void>> {
    const keys = new Set<string>();
    const rests: string[] = [];
    for (const id of ids) {
      const split = splitId(id);
      if (!split || !this.find(split.key)) return { ok: false, kind: "not_found", reason: "メールが見つかりません" };
      keys.add(split.key);
      rests.push(split.rest);
    }
    if (keys.size === 0) return { ok: true, value: undefined };
    if (keys.size > 1) {
      return { ok: false, kind: "failed", reason: CROSS_ACCOUNT_REASON };
    }
    const key = [...keys][0]!;
    const label = labelId ? splitId(labelId) : null;
    // ラベルは持ち主のアカウントのものだけを付け外しできる。
    const own = label && label.key === key ? label.rest : null;
    if ((action === "label-add" || action === "label-remove") && !own) {
      return { ok: false, kind: "failed", reason: "別のアカウントのラベルは付け外しできません" };
    }
    return this.find(key)!.inbox.apply(rests, action, own);
  }
}
