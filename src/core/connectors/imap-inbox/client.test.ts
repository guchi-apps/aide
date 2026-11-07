import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  decodeLabelId,
  decodeMessageId,
  encodeLabelId,
  encodeMessageId,
  ImapInbox,
  loadImapCredentials,
  targetFor,
  type ImapCredentials,
  type ImapSession,
} from "./client.ts";
import { decodeMimeWords, parseMime } from "./mime.ts";
import { toDetail } from "../gmail-inbox/message.ts";

const credentials: ImapCredentials = { host: "imap.example.com", port: 993, user: "me@example.com", password: "pw", ownerEmail: null };

interface Recorded {
  locked: string[];
  searched: Record<string, unknown>[];
  flagsAdded: [string, string[]][];
  flagsRemoved: [string, string[]][];
  moved: [string, string][];
  loggedOut: number;
}

function fakeSession(opts: { connectError?: unknown; uidValidity?: number; source?: string } = {}) {
  const rec: Recorded = { locked: [], searched: [], flagsAdded: [], flagsRemoved: [], moved: [], loggedOut: 0 };
  const uidValidity = opts.uidValidity ?? 7;
  const session: ImapSession = {
    async connect() {
      if (opts.connectError) throw opts.connectError;
    },
    async logout() {
      rec.loggedOut++;
    },
    close() {},
    async list() {
      return [
        { path: "INBOX" },
        { path: "Sent", specialUse: "\\Sent" },
        { path: "Trash", specialUse: "\\Trash" },
        { path: "Archive", specialUse: "\\Archive" },
        { path: "仕事" },
      ];
    },
    async getMailboxLock(path) {
      rec.locked.push(path);
      return { release() {} };
    },
    mailbox: { uidValidity },
    async search(query) {
      rec.searched.push(query);
      return [3, 10, 5];
    },
    async *fetch() {
      yield { uid: 10, flags: new Set<string>(), envelope: { subject: "新着", from: [{ name: "山田", address: "y@example.com" }] }, internalDate: new Date(1_700_000_000_000) };
      yield { uid: 5, flags: new Set(["\\Seen", "\\Flagged"]), envelope: { subject: "既読", from: [{ address: "a@example.com" }] }, internalDate: new Date(1_600_000_000_000) };
      yield { uid: 3, flags: new Set(["\\Seen"]), envelope: { subject: "古い", from: [] }, internalDate: new Date(1_500_000_000_000) };
    },
    async fetchOne() {
      return {
        uid: 10,
        flags: new Set<string>(),
        internalDate: new Date(1_700_000_000_000),
        source: Buffer.from(opts.source ?? "Subject: =?UTF-8?B?44GT44KT44Gr44Gh44Gv?=\r\nFrom: Y <y@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nhello"),
      };
    },
    async messageFlagsAdd(range, flags) {
      rec.flagsAdded.push([range, flags]);
      return true;
    },
    async messageFlagsRemove(range, flags) {
      rec.flagsRemoved.push([range, flags]);
      return true;
    },
    async messageMove(range, destination) {
      rec.moved.push([range, destination]);
      return {};
    },
  };
  return { session, rec };
}

async function inboxWith(session: ImapSession, creds: ImapCredentials | null = credentials) {
  const result = await ImapInbox.connect({ credentials: creds, createSession: () => session });
  assert.equal(result.ok, true);
  return (result as { ok: true; value: ImapInbox }).value;
}

describe("loadImapCredentials", () => {
  const names = ["AIDE_IMAP_HOST", "AIDE_IMAP_PORT", "AIDE_IMAP_USER", "AIDE_IMAP_PASSWORD", "AIDE_IMAP_OWNER_EMAIL"];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  afterEach(() => {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  });

  it("host・user・passwordが揃わなければ null、ポートの既定は993", () => {
    for (const n of names) delete process.env[n];
    assert.equal(loadImapCredentials(), null);
    process.env["AIDE_IMAP_HOST"] = "imap.example.com";
    process.env["AIDE_IMAP_USER"] = "me@example.com";
    assert.equal(loadImapCredentials(), null);
    process.env["AIDE_IMAP_PASSWORD"] = "pw";
    assert.equal(loadImapCredentials()?.port, 993);
    process.env["AIDE_IMAP_PORT"] = "abc";
    assert.equal(loadImapCredentials()?.port, 993);
    process.env["AIDE_IMAP_PORT"] = "143";
    assert.equal(loadImapCredentials()?.port, 143);
  });
});

describe("IDの符号化", () => {
  it("メッセージIDは往復でき、不正な形は null", () => {
    const id = encodeMessageId("仕事/2024", 7, 42);
    assert.deepEqual(decodeMessageId(id), { folder: "仕事/2024", uidValidity: "7", uid: 42 });
    assert.equal(decodeMessageId("abc"), null);
    assert.equal(decodeMessageId("a.b.c"), null);
    assert.equal(decodeMessageId(`${encodeMessageId("INBOX", 1, 1).split(".")[0]}.1.0`), null);
  });

  it("ラベルID（フォルダ）は往復でき、Gmailのラベルは対象外", () => {
    assert.equal(decodeLabelId(encodeLabelId("仕事")), "仕事");
    assert.equal(decodeLabelId("INBOX"), null);
    assert.equal(decodeLabelId("Label_12"), null);
  });
});

describe("targetFor（タブ→フォルダ・条件）", () => {
  it("受信トレイ・未読・スター・ゴミ箱・すべて・フォルダ", () => {
    assert.deepEqual(targetFor(["INBOX"]), { folder: "INBOX", special: null, unseenOnly: false, flaggedOnly: false });
    assert.deepEqual(targetFor(["INBOX", "UNREAD"]), { folder: "INBOX", special: null, unseenOnly: true, flaggedOnly: false });
    assert.deepEqual(targetFor(["STARRED"]), { folder: "INBOX", special: null, unseenOnly: false, flaggedOnly: true });
    assert.deepEqual(targetFor(["TRASH"]), { folder: null, special: "\\Trash", unseenOnly: false, flaggedOnly: false });
    assert.deepEqual(targetFor([]), { folder: null, special: "\\All", unseenOnly: false, flaggedOnly: false });
    assert.equal(targetFor([encodeLabelId("仕事")]).folder, "仕事");
  });
});

describe("ImapInbox", () => {
  it("接続情報が無ければ unconfigured", async () => {
    const result = await ImapInbox.connect({ credentials: null });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.kind, "unconfigured");
  });

  it("持ち主のメールアドレスはユーザー名、アドレスでなければ AIDE_IMAP_OWNER_EMAIL、どちらも無ければ断る", async () => {
    const { session } = fakeSession();
    const plain = await inboxWith(session);
    assert.deepEqual(await plain.profileEmail(), { ok: true, value: "me@example.com" });
    const user = await inboxWith(session, { ...credentials, user: "mailuser" });
    const refused = await user.profileEmail();
    assert.equal(refused.ok, false);
    const owner = await inboxWith(session, { ...credentials, user: "mailuser", ownerEmail: "me@example.com" });
    assert.deepEqual(await owner.profileEmail(), { ok: true, value: "me@example.com" });
  });

  it("認証失敗は unauthorized、その他の接続失敗は failed（理由に接続先や資格情報を含めない）", async () => {
    const bad = fakeSession({ connectError: Object.assign(new Error("secret pw"), { authenticationFailed: true }) });
    const a = await (await inboxWith(bad.session)).list({ labelIds: ["INBOX"], q: "", pageToken: null, includeSpamTrash: false });
    assert.equal(!a.ok && a.kind, "unauthorized");
    const down = fakeSession({ connectError: Object.assign(new Error("imap.example.com pw"), { code: "ECONNREFUSED" }) });
    const b = await (await inboxWith(down.session)).list({ labelIds: ["INBOX"], q: "", pageToken: null, includeSpamTrash: false });
    assert.equal(!b.ok && b.kind, "failed");
    assert.ok(!b.ok && !b.reason.includes("example.com") && !b.reason.includes("pw"));
  });

  it("フォルダの一覧は特殊フォルダ・INBOXを除いてラベルとして返す", async () => {
    const { session } = fakeSession();
    const labels = await (await inboxWith(session)).labels();
    assert.deepEqual(labels.ok && labels.value.map((l) => l.name), ["仕事"]);
  });

  it("一覧は新しいUID順で、未読・スターを写し、接続を閉じる", async () => {
    const { session, rec } = fakeSession();
    const page = await (await inboxWith(session)).list({ labelIds: ["INBOX", "UNREAD"], q: "請求", pageToken: null, includeSpamTrash: false });
    assert.equal(page.ok, true);
    if (!page.ok) return;
    assert.deepEqual(rec.locked, ["INBOX"]);
    assert.deepEqual(rec.searched[0], { seen: false, text: "請求" });
    assert.deepEqual(page.value.messages.map((m) => m.subject), ["新着", "既読", "古い"]);
    assert.deepEqual(page.value.messages.map((m) => m.unread), [true, false, false]);
    assert.deepEqual(page.value.messages.map((m) => m.starred), [false, true, false]);
    assert.equal(page.value.messages[0]!.from, '"山田" <y@example.com>');
    assert.equal(page.value.nextPageToken, null);
    assert.equal(rec.loggedOut, 1);
  });

  it("ゴミ箱タブは \\Trash のフォルダを開く", async () => {
    const { session, rec } = fakeSession();
    await (await inboxWith(session)).list({ labelIds: ["TRASH"], q: "", pageToken: null, includeSpamTrash: true });
    assert.deepEqual(rec.locked, ["Trash"]);
  });

  it("本文は MIME を解いて返し、UIDVALIDITY が違えば not_found", async () => {
    const { session } = fakeSession();
    const id = encodeMessageId("INBOX", 7, 10);
    const ok = await (await inboxWith(session)).get(id);
    assert.equal(ok.ok && ok.value.subject, "こんにちは");
    assert.equal(ok.ok && ok.value.text, "hello");
    const changed = fakeSession({ uidValidity: 8 });
    const stale = await (await inboxWith(changed.session)).get(id);
    assert.equal(!stale.ok && stale.kind, "not_found");
    const bad = await (await inboxWith(session)).get("zzz");
    assert.equal(!bad.ok && bad.kind, "not_found");
  });

  it("操作: 既読/スターはフラグ、ゴミ箱・アーカイブ・戻しは移動、完全削除とラベルは持たない", async () => {
    const { session, rec } = fakeSession();
    const inbox = await inboxWith(session);
    const a = encodeMessageId("INBOX", 7, 10);
    const b = encodeMessageId("INBOX", 7, 11);
    assert.equal((await inbox.apply([a, b], "read", null)).ok, true);
    assert.equal((await inbox.apply([a], "unread", null)).ok, true);
    assert.equal((await inbox.apply([a], "star", null)).ok, true);
    assert.equal((await inbox.apply([a], "unstar", null)).ok, true);
    assert.equal((await inbox.apply([a], "trash", null)).ok, true);
    assert.equal((await inbox.apply([a], "archive", null)).ok, true);
    assert.equal((await inbox.apply([a], "untrash", null)).ok, true);
    assert.deepEqual(rec.flagsAdded, [["10,11", ["\\Seen"]], ["10", ["\\Flagged"]]]);
    assert.deepEqual(rec.flagsRemoved, [["10", ["\\Seen"]], ["10", ["\\Flagged"]]]);
    assert.deepEqual(rec.moved, [["10", "Trash"], ["10", "Archive"], ["10", "INBOX"]]);
    const label = await inbox.apply([a], "label-add", "Fxx");
    assert.equal(label.ok, false);
  });

  it("操作: UIDVALIDITY が変わっていれば何も変えない", async () => {
    const { session, rec } = fakeSession({ uidValidity: 9 });
    const result = await (await inboxWith(session)).apply([encodeMessageId("INBOX", 7, 10)], "trash", null);
    assert.equal(!result.ok && result.kind, "not_found");
    assert.deepEqual(rec.moved, []);
  });
});

describe("parseMime", () => {
  it("multipart/alternative のHTMLとテキスト、quoted-printable・base64、添付を畳む", () => {
    const raw = [
      "Subject: =?ISO-2022-JP?B?GyRCJTUlcyVXJWsbKEI=?=",
      "To: a@example.com",
      'Content-Type: multipart/mixed; boundary="outer"',
      "",
      "--outer",
      'Content-Type: multipart/alternative; boundary="inner"',
      "",
      "--inner",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "=E3=81=82=E3=81=84",
      "--inner",
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("<p>HTML</p>").toString("base64"),
      "--inner--",
      "--outer",
      'Content-Type: application/pdf; name="請求.pdf"',
      'Content-Disposition: attachment; filename="invoice.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("PDFDATA").toString("base64"),
      "--outer--",
      "",
    ].join("\r\n");
    const detail = toDetail({ id: "x", payload: parseMime(Buffer.from(raw)) });
    assert.equal(detail.subject, "サンプル");
    assert.equal(detail.text, "あい");
    assert.equal(detail.html, "<p>HTML</p>");
    assert.deepEqual(detail.attachments.map((a) => a.filename), ["invoice.pdf"]);
    assert.equal(detail.to, "a@example.com");
  });

  it("charset の無いISO-2022-JP本文を読める（#771）", () => {
    const body = Buffer.from([0x1b, 0x24, 0x42, 0x24, 0x22, 0x1b, 0x28, 0x42]);
    const raw = Buffer.concat([Buffer.from("Content-Type: text/plain\r\n\r\n"), body]);
    assert.equal(toDetail({ id: "x", payload: parseMime(raw) }).text, "あ");
  });

  it("RFC 2047 の連続する語を連結して解く", () => {
    assert.equal(decodeMimeWords("=?UTF-8?Q?a_b?= =?UTF-8?Q?c?="), "a bc");
  });
});
