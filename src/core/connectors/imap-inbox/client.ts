import { ImapFlow } from "imapflow";
import type {
  GmailFailureKind,
  GmailLabel,
  GmailResult,
  ListQuery,
  MailAction,
  MailInbox,
  MailPage,
} from "../gmail-inbox/client.ts";
import { toDetail, toSummary, type GmailApiMessage, type MailDetail } from "../gmail-inbox/message.ts";
import { parseMime } from "./mime.ts";

/**
 * メール画面（`/mail`）のIMAP版の取得元（#782）。Gmail以外のメールアドレスを読む。
 *
 * **接続は1操作ごとに開いて閉じる。** 画面の1回の表示・1回の操作の間だけ持ち、常駐させない
 * （`GmailInbox` がアクセストークンをその間だけ持つのと同じ）。TLS（暗号化接続）が前提で、平文は使わない。
 *
 * **IDの表し方。** IMAPのUIDはフォルダごとに採番されるため、メッセージIDは
 * `<フォルダ名(base64url)>.<UIDVALIDITY>.<UID>` とする。UIDVALIDITY が変わった（サーバー側で
 * フォルダが作り直された）IDは別のメールを指しうるので `not_found` にする。
 * ラベルIDはフォルダの `F<フォルダ名(base64url)>`。
 *
 * **持つ操作は元に戻せるものだけ。** 既読/未読・スター・フォルダ間の移動（ゴミ箱への移動と戻し）。
 * 完全削除（`EXPUNGE`）は持たない。IMAPにラベルは無いので付け外しは受けない。
 * **メール本文は保存しない。**
 */

const CONNECT_TIMEOUT_MS = 15_000;
export const IMAP_PAGE_SIZE = 25;
const MAX_SOURCE_BYTES = 5 * 1024 * 1024;

export interface ImapCredentials {
  host: string;
  port: number;
  user: string;
  password: string;
  /** ユーザー名がメールアドレスの形でないサービス向けに、持ち主のメールアドレスを別に指定する。 */
  ownerEmail: string | null;
}

export function loadImapCredentials(): ImapCredentials | null {
  const host = (process.env["AIDE_IMAP_HOST"] ?? "").trim();
  const user = (process.env["AIDE_IMAP_USER"] ?? "").trim();
  const password = process.env["AIDE_IMAP_PASSWORD"] ?? "";
  if (!host || !user || !password) return null;
  const port = Number.parseInt((process.env["AIDE_IMAP_PORT"] ?? "").trim(), 10);
  const ownerEmail = (process.env["AIDE_IMAP_OWNER_EMAIL"] ?? "").trim();
  return {
    host,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 993,
    user,
    password,
    ownerEmail: ownerEmail || null,
  };
}

/** imapflow のうち使う部分だけ。テストではここを差し替える。 */
export interface ImapSession {
  connect(): Promise<void>;
  logout(): Promise<void>;
  close(): void;
  list(): Promise<{ path: string; specialUse?: string | undefined; flags?: Set<string> }[]>;
  getMailboxLock(path: string): Promise<{ release(): void }>;
  readonly mailbox: { uidValidity: bigint | number } | false;
  search(query: Record<string, unknown>, options: { uid: true }): Promise<number[] | false | undefined>;
  fetch(
    range: string,
    query: Record<string, unknown>,
    options: { uid: true },
  ): AsyncIterable<{
    uid: number;
    flags?: Set<string> | undefined;
    envelope?: { subject?: string | undefined; from?: { name?: string | undefined; address?: string | undefined }[] | undefined } | undefined;
    internalDate?: Date | string | undefined;
  }>;
  fetchOne(
    range: string,
    query: Record<string, unknown>,
    options: { uid: true },
  ): Promise<false | { uid: number; flags?: Set<string> | undefined; source?: Buffer | undefined; internalDate?: Date | string | undefined }>;
  messageFlagsAdd(range: string, flags: string[], options: { uid: true }): Promise<boolean>;
  messageFlagsRemove(range: string, flags: string[], options: { uid: true }): Promise<boolean>;
  messageMove(range: string, destination: string, options: { uid: true }): Promise<unknown>;
}

export interface ImapInboxDeps {
  credentials?: ImapCredentials | null;
  createSession?: (credentials: ImapCredentials) => ImapSession;
}

function defaultSession(credentials: ImapCredentials): ImapSession {
  return new ImapFlow({
    host: credentials.host,
    port: credentials.port,
    secure: true,
    auth: { user: credentials.user, pass: credentials.password },
    logger: false,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    connectionTimeout: CONNECT_TIMEOUT_MS,
  }) as unknown as ImapSession;
}

// ---- ID ----

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");
const unb64 = (text: string) => Buffer.from(text, "base64url").toString("utf8");

export function encodeMessageId(folder: string, uidValidity: bigint | number, uid: number): string {
  return `${b64(folder)}.${uidValidity}.${uid}`;
}

export function decodeMessageId(id: string): { folder: string; uidValidity: string; uid: number } | null {
  const match = /^([A-Za-z0-9_-]+)\.(\d+)\.(\d+)$/.exec(id);
  if (!match) return null;
  const folder = unb64(match[1]!);
  const uid = Number(match[3]);
  if (!folder || !Number.isSafeInteger(uid) || uid <= 0) return null;
  return { folder, uidValidity: match[2]!, uid };
}

export function encodeLabelId(folder: string): string {
  return `F${b64(folder)}`;
}

export function decodeLabelId(label: string): string | null {
  if (!/^F[A-Za-z0-9_-]+$/.test(label)) return null;
  return unb64(label.slice(1)) || null;
}

// ---- 画面のタブ（Gmailの labelIds）をIMAPの検索へ写す ----

interface Target {
  /** 開くフォルダ。`null` は特殊フォルダ（種別）を引いて決める。 */
  folder: string | null;
  special: "\\Trash" | "\\All" | null;
  unseenOnly: boolean;
  flaggedOnly: boolean;
}

export function targetFor(labelIds: string[]): Target {
  const fromLabel = labelIds.map(decodeLabelId).find((f): f is string => f !== null);
  if (fromLabel) return { folder: fromLabel, special: null, unseenOnly: false, flaggedOnly: false };
  if (labelIds.includes("TRASH")) return { folder: null, special: "\\Trash", unseenOnly: false, flaggedOnly: false };
  const inbox = labelIds.includes("INBOX");
  return {
    folder: inbox || labelIds.includes("STARRED") ? "INBOX" : null,
    special: inbox || labelIds.includes("STARRED") ? null : "\\All",
    unseenOnly: labelIds.includes("UNREAD"),
    flaggedOnly: labelIds.includes("STARRED"),
  };
}

function toIso(date: Date | string | undefined): string {
  const time = date instanceof Date ? date.getTime() : date ? Date.parse(date) : NaN;
  return Number.isFinite(time) ? String(time) : "";
}

function formatAddress(a: { name?: string | undefined; address?: string | undefined }): string {
  if (a.name && a.address) return `"${a.name.replaceAll('"', "")}" <${a.address}>`;
  return a.address ?? a.name ?? "";
}

type Special = { path: string; specialUse?: string | undefined };

function failure<T>(kind: GmailFailureKind, reason: string): GmailResult<T> {
  return { ok: false, kind, reason };
}

function classify(cause: unknown): { kind: GmailFailureKind; reason: string } {
  const e = cause as { authenticationFailed?: boolean; code?: string; responseStatus?: string } | null;
  if (e?.authenticationFailed || e?.responseStatus === "NO" && e.code === "AUTHENTICATIONFAILED") {
    return { kind: "unauthorized", reason: "IMAPの認証に失敗しました" };
  }
  // 接続先・メール内容を含みうるメッセージは出さない。
  return { kind: "failed", reason: `IMAPの処理に失敗しました（${typeof e?.code === "string" ? e.code : "error"}）` };
}

export class ImapInbox implements MailInbox {
  readonly kind = "imap" as const;
  readonly supportsLabels = false;
  private readonly credentials: ImapCredentials;
  private readonly createSession: (credentials: ImapCredentials) => ImapSession;

  private constructor(credentials: ImapCredentials, createSession: (c: ImapCredentials) => ImapSession) {
    this.credentials = credentials;
    this.createSession = createSession;
  }

  static async connect(deps: ImapInboxDeps = {}): Promise<GmailResult<ImapInbox>> {
    const credentials = deps.credentials === undefined ? loadImapCredentials() : deps.credentials;
    if (!credentials) return failure("unconfigured", "IMAPの接続情報が設定されていません");
    return { ok: true, value: new ImapInbox(credentials, deps.createSession ?? defaultSession) };
  }

  /** 1操作ぶんの接続を開いて `fn` を実行し、必ず閉じる。 */
  private async withSession<T>(fn: (session: ImapSession) => Promise<GmailResult<T>>): Promise<GmailResult<T>> {
    const session = this.createSession(this.credentials);
    try {
      await session.connect();
    } catch (cause) {
      const c = classify(cause);
      return failure(c.kind, c.reason);
    }
    try {
      return await fn(session);
    } catch (cause) {
      const c = classify(cause);
      return failure(c.kind, c.reason);
    } finally {
      try {
        await session.logout();
      } catch {
        session.close();
      }
    }
  }

  private async folderOf(session: ImapSession, special: string): Promise<string | null> {
    const boxes: Special[] = await session.list();
    return boxes.find((b) => b.specialUse === special)?.path ?? null;
  }

  /** メールボックスの持ち主のメールアドレス。ユーザー名がアドレスならそれ、でなければ `AIDE_IMAP_OWNER_EMAIL`。 */
  async profileEmail(): Promise<GmailResult<string>> {
    const candidate = this.credentials.ownerEmail ?? this.credentials.user;
    if (!candidate.includes("@")) {
      return failure("unauthorized", "IMAPのユーザー名がメールアドレスではありません（AIDE_IMAP_OWNER_EMAIL を設定してください）");
    }
    return { ok: true, value: candidate };
  }

  async labels(): Promise<GmailResult<GmailLabel[]>> {
    return this.withSession(async (session) => {
      const boxes: Special[] = await session.list();
      const labels = boxes
        .filter((b) => b.path.toUpperCase() !== "INBOX" && !b.specialUse)
        .map((b) => ({ id: encodeLabelId(b.path), name: b.path, type: "user" as const }));
      return { ok: true, value: labels };
    });
  }

  async list(query: ListQuery): Promise<GmailResult<MailPage>> {
    const target = targetFor(query.labelIds);
    const offset = /^\d{1,7}$/.test(query.pageToken ?? "") ? Number(query.pageToken) : 0;
    return this.withSession(async (session) => {
      const folder = target.folder ?? (await this.folderOf(session, target.special ?? "\\All")) ?? "INBOX";
      const lock = await session.getMailboxLock(folder);
      try {
        const uidValidity = session.mailbox ? session.mailbox.uidValidity : 0;
        const criteria: Record<string, unknown> = {};
        if (target.unseenOnly) criteria["seen"] = false;
        if (target.flaggedOnly) criteria["flagged"] = true;
        if (query.q) criteria["text"] = query.q;
        const found = (await session.search(Object.keys(criteria).length ? criteria : { all: true }, { uid: true })) || [];
        const uids = [...found].sort((a, b) => b - a);
        const slice = uids.slice(offset, offset + IMAP_PAGE_SIZE);
        const summaries = [];
        if (slice.length > 0) {
          const byUid = new Map<number, ReturnType<typeof toSummary>>();
          for await (const m of session.fetch(slice.join(","), { uid: true, flags: true, envelope: true, internalDate: true }, { uid: true })) {
            byUid.set(m.uid, toSummary(this.toApiMessage(folder, uidValidity, m.uid, m.flags, m.internalDate, m.envelope)));
          }
          for (const uid of slice) {
            const summary = byUid.get(uid);
            if (summary) summaries.push(summary);
          }
        }
        const next = offset + IMAP_PAGE_SIZE;
        return {
          ok: true,
          value: {
            messages: summaries,
            nextPageToken: next < uids.length ? String(next) : null,
            resultSizeEstimate: uids.length,
          },
        };
      } finally {
        lock.release();
      }
    });
  }

  private toApiMessage(
    folder: string,
    uidValidity: bigint | number,
    uid: number,
    flags: Set<string> | undefined,
    internalDate: Date | string | undefined,
    envelope?: { subject?: string | undefined; from?: { name?: string | undefined; address?: string | undefined }[] | undefined },
  ): GmailApiMessage {
    const labelIds: string[] = [];
    if (folder.toUpperCase() === "INBOX") labelIds.push("INBOX");
    if (!flags?.has("\\Seen")) labelIds.push("UNREAD");
    if (flags?.has("\\Flagged")) labelIds.push("STARRED");
    const id = encodeMessageId(folder, uidValidity, uid);
    return {
      id,
      labelIds,
      internalDate: toIso(internalDate),
      payload: {
        headers: [
          { name: "From", value: (envelope?.from ?? []).map(formatAddress).join(", ") },
          { name: "Subject", value: envelope?.subject ?? "" },
        ],
      },
    };
  }

  async get(id: string): Promise<GmailResult<MailDetail>> {
    const ref = decodeMessageId(id);
    if (!ref) return failure("not_found", "メールが見つかりません");
    return this.withSession(async (session) => {
      const lock = await session.getMailboxLock(ref.folder);
      try {
        const uidValidity = session.mailbox ? session.mailbox.uidValidity : 0;
        if (String(uidValidity) !== ref.uidValidity) return failure<MailDetail>("not_found", "メールが見つかりません");
        const m = await session.fetchOne(
          String(ref.uid),
          { uid: true, flags: true, internalDate: true, source: { maxLength: MAX_SOURCE_BYTES } },
          { uid: true },
        );
        if (!m || !m.source) return failure<MailDetail>("not_found", "メールが見つかりません");
        const api = this.toApiMessage(ref.folder, uidValidity, ref.uid, m.flags, m.internalDate);
        api.payload = parseMime(m.source);
        return { ok: true, value: toDetail(api) };
      } finally {
        lock.release();
      }
    });
  }

  async apply(ids: string[], action: MailAction, _labelId: string | null): Promise<GmailResult<void>> {
    if (ids.length === 0) return { ok: true, value: undefined };
    if (action === "label-add" || action === "label-remove") {
      return failure("failed", "IMAPではラベルを使えません");
    }
    const refs = ids.map(decodeMessageId);
    if (refs.some((r) => r === null)) return failure("not_found", "メールが見つかりません");
    const byFolder = new Map<string, { uidValidity: string; uids: number[] }>();
    for (const r of refs) {
      const entry = byFolder.get(r!.folder) ?? { uidValidity: r!.uidValidity, uids: [] };
      entry.uids.push(r!.uid);
      byFolder.set(r!.folder, entry);
    }
    return this.withSession(async (session) => {
      for (const [folder, { uidValidity, uids }] of byFolder) {
        const lock = await session.getMailboxLock(folder);
        try {
          const current = session.mailbox ? session.mailbox.uidValidity : 0;
          if (String(current) !== uidValidity) return failure<void>("not_found", "メールが見つかりません");
          const range = uids.join(",");
          switch (action) {
            case "read":
              await session.messageFlagsAdd(range, ["\\Seen"], { uid: true });
              break;
            case "unread":
              await session.messageFlagsRemove(range, ["\\Seen"], { uid: true });
              break;
            case "star":
              await session.messageFlagsAdd(range, ["\\Flagged"], { uid: true });
              break;
            case "unstar":
              await session.messageFlagsRemove(range, ["\\Flagged"], { uid: true });
              break;
            case "trash": {
              const trash = await this.folderOf(session, "\\Trash");
              if (!trash) return failure<void>("failed", "ゴミ箱フォルダが見つかりません");
              await session.messageMove(range, trash, { uid: true });
              break;
            }
            case "archive": {
              const archive = await this.folderOf(session, "\\Archive");
              if (!archive) return failure<void>("failed", "アーカイブフォルダが見つかりません");
              await session.messageMove(range, archive, { uid: true });
              break;
            }
            case "inbox":
            case "untrash":
              await session.messageMove(range, "INBOX", { uid: true });
              break;
          }
        } finally {
          lock.release();
        }
      }
      return { ok: true, value: undefined };
    });
  }
}
