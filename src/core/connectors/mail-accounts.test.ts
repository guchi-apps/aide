import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GmailResult, ListQuery, MailAction, MailInbox } from "./gmail-inbox/client.ts";
import type { MailDetail, MailSummary } from "./gmail-inbox/message.ts";
import { loadExtraMailAccounts, MultiMailInbox, splitId } from "./mail-accounts.ts";

function summary(id: string, at: number): MailSummary {
  return { id, threadId: id, from: "a", subject: id, snippet: "", receivedAt: at, labelIds: ["INBOX", "Label_1"], unread: true, starred: false };
}

function fake(kind: "gmail" | "imap", messages: MailSummary[], opts: { fail?: boolean; next?: string } = {}) {
  const calls: { apply: { ids: string[]; action: MailAction; label: string | null }[]; list: ListQuery[] } = { apply: [], list: [] };
  const inbox: MailInbox = {
    kind,
    supportsLabels: kind === "gmail",
    async profileEmail() { return { ok: true, value: `${kind}@example.com` }; },
    async labels() { return { ok: true, value: [{ id: "Label_1", name: "仕事", type: "user" }] }; },
    async list(query) {
      calls.list.push(query);
      if (opts.fail) return { ok: false, kind: "failed", reason: "x" };
      return { ok: true, value: { messages, nextPageToken: opts.next ?? null, resultSizeEstimate: messages.length } };
    },
    async get(id) { return { ok: true, value: { ...summary(id, 1), to: "", cc: "", html: null, text: "t", attachments: [] } as MailDetail }; },
    async apply(ids, action, label): Promise<GmailResult<void>> { calls.apply.push({ ids, action, label }); return { ok: true, value: undefined }; },
  };
  return { inbox, calls };
}

const query: ListQuery = { labelIds: ["INBOX"], q: "", pageToken: null, includeSpamTrash: false };
const extra = { key: "sub", name: "サブ", credentials: { host: "h", port: 993, user: "u@x", password: "p", ownerEmail: null } };

describe("loadExtraMailAccounts", () => {
  it("不正な要素・重複・main は読み飛ばす", () => {
    const raw = JSON.stringify([
      { name: "sub", label: "サブ", host: "h", user: "u", password: "p" },
      { name: "sub", host: "h", user: "u", password: "p" },
      { name: "main", host: "h", user: "u", password: "p" },
      { name: "Bad Name", host: "h", user: "u", password: "p" },
      { name: "nopw", host: "h", user: "u" },
    ]);
    const accounts = loadExtraMailAccounts(raw);
    assert.deepEqual(accounts.map((a) => [a.key, a.name, a.credentials.port]), [["sub", "サブ", 993]]);
    assert.deepEqual(loadExtraMailAccounts("{oops"), []);
    assert.deepEqual(loadExtraMailAccounts(undefined), []);
  });
});

describe("MultiMailInbox", () => {
  async function setup(subOpts = {}) {
    const main = fake("gmail", [summary("m1", 300), summary("m2", 100)]);
    const sub = fake("imap", [summary("s1", 200)], subOpts);
    const multi = await MultiMailInbox.connect(main.inbox, [extra], { createSession: undefined });
    assert.ok(multi.ok);
    // 追加アカウントのIMAPをフェイクへ差し替える。
    (multi.value as unknown as { members: { inbox: MailInbox }[] }).members[1]!.inbox = sub.inbox;
    return { multi: multi.value, main, sub };
  }

  it("日付の新しい順に混ぜ、IDにアカウントの鍵を付ける", async () => {
    const { multi } = await setup();
    const page = await multi.list(query);
    assert.ok(page.ok);
    assert.deepEqual(page.value.messages.map((m) => m.id), ["main~m1", "sub~s1", "main~m2"]);
    assert.deepEqual(page.value.messages.map((m) => m.account), ["メイン", "サブ", "メイン"]);
    assert.deepEqual(page.value.messages[0]!.labelIds, ["INBOX", "main~Label_1"]);
  });

  it("アカウントで絞ると、そのアカウントだけを読む", async () => {
    const { multi, main, sub } = await setup();
    await multi.list({ ...query, account: "sub" });
    assert.equal(main.calls.list.length, 0);
    assert.equal(sub.calls.list.length, 1);
  });

  it("1アカウントが失敗しても残りを出し、失敗したアカウント名を返す", async () => {
    const { multi } = await setup({ fail: true });
    const page = await multi.list(query);
    assert.ok(page.ok);
    assert.equal(page.value.messages.length, 2);
    assert.deepEqual(page.value.failedAccounts, ["サブ"]);
  });

  it("次ページの位置を持つアカウントだけを2ページ目で読む", async () => {
    const { multi, main, sub } = await setup({ next: "5" });
    const first = await multi.list(query);
    assert.ok(first.ok && first.value.nextPageToken);
    main.calls.list.length = 0;
    await multi.list({ ...query, pageToken: first.value.nextPageToken });
    assert.equal(main.calls.list.length, 0);
    assert.equal(sub.calls.list.at(-1)!.pageToken, "5");
  });

  it("操作はIDの鍵のアカウントへ振り分ける。別アカウントのラベルは付けられない", async () => {
    const { multi, main, sub } = await setup();
    assert.ok((await multi.apply(["main~m1", "sub~s1", "main~m2"], "read", null)).ok);
    assert.deepEqual(main.calls.apply[0]!.ids, ["m1", "m2"]);
    assert.deepEqual(sub.calls.apply[0]!.ids, ["s1"]);
    assert.ok((await multi.apply(["main~m1"], "label-add", "main~Label_1")).ok);
    assert.equal(main.calls.apply[1]!.label, "Label_1");
    const cross = await multi.apply(["sub~s1"], "label-add", "main~Label_1");
    assert.equal(cross.ok, false);
    const unknown = await multi.apply(["zzz~x"], "read", null);
    assert.equal(unknown.ok, false);
  });

  it("本文はIDの鍵のアカウントから取り、持ち主の確認はメインで行う", async () => {
    const { multi } = await setup();
    const detail = await multi.get("sub~s9");
    assert.ok(detail.ok);
    assert.equal(detail.value.id, "sub~s9");
    assert.equal(detail.value.account, "サブ");
    assert.equal((await multi.get("s9")).ok, false);
    const profile = await multi.profileEmail();
    assert.ok(profile.ok && profile.value === "gmail@example.com");
    assert.equal(splitId("sub~a.b.c")?.rest, "a.b.c");
  });
});
