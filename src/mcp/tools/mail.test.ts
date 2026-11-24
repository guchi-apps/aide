import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GmailResult, MailInbox, MailPage } from "../../core/connectors/gmail-inbox/client.ts";
import type { MailDetail, MailSummary } from "../../core/connectors/gmail-inbox/message.ts";
import { DEV_AUTH_DISABLED_CLIENT_ID, type ToolContext } from "../types.ts";
import {
  BODY_MAX_PER_MESSAGE,
  BODY_MAX_TOTAL,
  createMailGetTool,
  createMailSearchTool,
  htmlToText,
  NOTICE,
} from "./mail.ts";

const OWNER = "owner@example.com";
const ctx = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  sessionId: null,
  scopes: ["mail:read"],
  clientId: "client-1",
  subject: { sub: "sub-1", email: "Owner@Example.com" },
  ...overrides,
});

function summary(id: string, overrides: Partial<MailSummary> = {}): MailSummary {
  return {
    id,
    threadId: id,
    from: "a@example.com",
    subject: `件名${id}`,
    snippet: "冒頭 &amp; 続き",
    receivedAt: Date.UTC(2026, 10, 24, 1, 2, 3),
    labelIds: ["INBOX", "UNREAD"],
    unread: true,
    starred: false,
    ...overrides,
  };
}

function detail(id: string, overrides: Partial<MailDetail> = {}): MailDetail {
  return { ...summary(id), to: OWNER, cc: "", html: null, text: "本文", attachments: [], ...overrides };
}

interface Fake {
  deps: { mail: { connect: () => Promise<GmailResult<MailInbox>> } };
  listed: unknown[];
}

function fake(opts: {
  owner?: string;
  connect?: GmailResult<never> | null;
  page?: GmailResult<MailPage>;
  details?: Record<string, MailDetail>;
}): Fake {
  const listed: unknown[] = [];
  const inbox = {
    kind: "gmail",
    supportsLabels: true,
    profileEmail: async () => ({ ok: true, value: opts.owner ?? OWNER }),
    list: async (q: unknown) => {
      listed.push(q);
      return opts.page ?? { ok: true, value: { messages: [], nextPageToken: null, resultSizeEstimate: 0 } };
    },
    get: async (id: string) =>
      opts.details?.[id] ? { ok: true, value: opts.details[id] } : { ok: false, kind: "not_found", reason: "x" },
  } as unknown as MailInbox;
  return {
    deps: { mail: { connect: async () => (opts.connect ?? { ok: true, value: inbox }) as GmailResult<MailInbox> } },
    listed,
  };
}

const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text);

describe("aide_mail_search", () => {
  it("一覧を返す。snippetは200字で切り、HTMLの文字参照を戻す。0件は messages: []", async () => {
    const long = "あ".repeat(500);
    const f = fake({
      page: { ok: true, value: { messages: [summary("m1", { snippet: long }), summary("m2", { labelIds: [], unread: false })], nextPageToken: null, resultSizeEstimate: 2 } },
    });
    const tool = createMailSearchTool(f.deps);
    const res = await tool.handler({ query: "請求", limit: 1 }, ctx());
    assert.equal(res.isError, undefined);
    const body = parse(res);
    assert.equal(body.partial, false);
    assert.deepEqual(body.failedAccounts, []);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].snippet.length, 200);
    assert.equal(body.messages[0].receivedAt, "2026-11-24T01:02:03.000Z");
    assert.deepEqual(Object.keys(body.messages[0]).sort(), ["from", "id", "inInbox", "receivedAt", "snippet", "subject", "unread"]);

    const all = parse(await tool.handler({ query: "x", limit: 2 }, ctx()));
    assert.equal(all.messages[1].inInbox, false);
    const entity = parse(
      await createMailSearchTool(fake({ page: { ok: true, value: { messages: [summary("m3")], nextPageToken: null, resultSizeEstimate: 1 } } }).deps).handler({ query: "x" }, ctx()),
    );
    assert.equal(entity.messages[0].snippet, "冒頭 & 続き");

    const empty = parse(await createMailSearchTool(fake({}).deps).handler({ query: "x" }, ctx()));
    assert.deepEqual(empty, { partial: false, failedAccounts: [], messages: [] });
  });

  it("view は既定が all で、ゴミ箱は含めない。inbox は INBOX に絞る", async () => {
    const f = fake({});
    const tool = createMailSearchTool(f.deps);
    await tool.handler({ query: "x" }, ctx());
    await tool.handler({ query: "x", view: "inbox" }, ctx());
    assert.deepEqual(f.listed.map((q) => (q as { labelIds: string[] }).labelIds), [[], ["INBOX"]]);
    assert.ok(f.listed.every((q) => (q as { includeSpamTrash: boolean }).includeSpamTrash === false));
  });

  it("一部のアカウントが読めないときは partial: true と failedAccounts を付けて、読めた分を返す", async () => {
    const f = fake({
      page: { ok: true, value: { messages: [summary("m1")], failedAccounts: ["サブ"], nextPageToken: null, resultSizeEstimate: 1 } },
    });
    const body = parse(await createMailSearchTool(f.deps).handler({ query: "x" }, ctx()));
    assert.equal(body.partial, true);
    assert.deepEqual(body.failedAccounts, ["サブ"]);
    assert.equal(body.messages.length, 1);
  });

  it("入力の範囲外は失敗にする", async () => {
    const tool = createMailSearchTool(fake({}).deps);
    for (const args of [{}, { query: "" }, { query: "a".repeat(201) }, { query: "x", view: "trash" }, { query: "x", limit: 0 }, { query: "x", limit: 21 }, { query: "x", limit: 1.5 }]) {
      assert.equal((await tool.handler(args, ctx())).isError, true, JSON.stringify(args));
    }
  });
});

describe("本人照合の4つの失敗は、どれも『メール0件』と読ませない（#905）", () => {
  const search = (f: Fake, c: ToolContext) => createMailSearchTool(f.deps).handler({ query: "x" }, c);

  it("scope mail:read が無ければ呼べない（requiredScopes）", () => {
    assert.deepEqual(createMailSearchTool().requiredScopes, ["mail:read"]);
    assert.deepEqual(createMailGetTool().requiredScopes, ["mail:read"]);
  });

  it("本人記録の無い古いトークン", async () => {
    const res = await search(fake({}), ctx({ subject: null }));
    assert.equal(res.isError, true);
    assert.match(res.content[0]!.text, /本人の記録がありません.*再ログイン/);
    assert.match(res.content[0]!.text, /0件という意味ではありません/);
  });

  it("本人がメールの持ち主でない", async () => {
    const res = await search(fake({ owner: "someone@example.com" }), ctx());
    assert.equal(res.isError, true);
    assert.match(res.content[0]!.text, /持ち主ではない/);
  });

  it("メールを取得できない（設定なし・全アカウント失敗）", async () => {
    for (const f of [
      fake({ connect: { ok: false, kind: "unconfigured", reason: "x" } }),
      fake({ page: { ok: false, kind: "failed", reason: "x" } }),
    ]) {
      const res = await search(f, ctx());
      assert.equal(res.isError, true);
      assert.match(res.content[0]!.text, /取得できませんでした/);
    }
  });

  it("4つの文面は互いに違い、持ち主の照合は大文字小文字を無視する", async () => {
    const ok = await search(fake({}), ctx({ subject: { sub: "s", email: "OWNER@EXAMPLE.COM" } }));
    assert.equal(ok.isError, undefined);
    const texts = new Set([
      (await search(fake({}), ctx({ subject: null }))).content[0]!.text,
      (await search(fake({ owner: "x@example.com" }), ctx())).content[0]!.text,
      (await search(fake({ connect: { ok: false, kind: "unconfigured", reason: "x" } }), ctx())).content[0]!.text,
    ]);
    assert.equal(texts.size, 3);
  });

  it("認証無効の開発起動は本人を持たないが通す", async () => {
    const res = await search(fake({}), ctx({ clientId: DEV_AUTH_DISABLED_CLIENT_ID, subject: null }));
    assert.equal(res.isError, undefined);
  });
});

describe("aide_mail_get", () => {
  const get = (f: Fake, ids: unknown) => createMailGetTool(f.deps).handler({ ids }, ctx());

  it("本文・notice・missing を返す。見つからないIDは missing へ（全体は失敗にしない）", async () => {
    const f = fake({ details: { m1: detail("m1") } });
    const res = await get(f, ["m1", "nope", "bad id!"]);
    assert.equal(res.isError, undefined);
    const body = parse(res);
    assert.equal(body.notice, NOTICE);
    assert.deepEqual(body.missing, ["nope", "bad id!"]);
    assert.deepEqual(body.messages, [
      { id: "m1", from: "a@example.com", to: OWNER, subject: "件名m1", receivedAt: "2026-11-24T01:02:03.000Z", body: "本文", truncated: false },
    ]);
  });

  it("HTMLしか無いメールはタグを除いたテキストにする", async () => {
    const f = fake({ details: { m1: detail("m1", { text: null, html: "<style>p{}</style><p>こんにちは&amp;<b>世界</b></p>次" }) } });
    const body = parse(await get(f, ["m1"]));
    assert.equal(body.messages[0].body, "こんにちは& 世界\n次");
    assert.equal(htmlToText("<script>x()</script>a"), "a");
  });

  it("1通3,000字で切って truncated: true", async () => {
    const f = fake({ details: { m1: detail("m1", { text: "い".repeat(BODY_MAX_PER_MESSAGE + 1) }), m2: detail("m2", { text: "う".repeat(BODY_MAX_PER_MESSAGE) }) } });
    const body = parse(await get(f, ["m1", "m2"]));
    assert.equal(body.messages[0].body.length, BODY_MAX_PER_MESSAGE);
    assert.equal(body.messages[0].truncated, true);
    assert.equal(body.messages[1].truncated, false, "ちょうど3,000字は切らない");
  });

  it("全体で12,000字を超えた分は後ろの通から削る", async () => {
    const details = Object.fromEntries(
      ["a", "b", "c", "d", "e"].map((id) => [id, detail(id, { text: "x".repeat(BODY_MAX_PER_MESSAGE) })]),
    );
    const body = parse(await get(fake({ details }), ["a", "b", "c", "d", "e"]));
    const lengths = body.messages.map((m: { body: string }) => m.body.length);
    assert.deepEqual(lengths, [3000, 3000, 3000, 3000, 0]);
    assert.equal(lengths.reduce((a: number, b: number) => a + b, 0), BODY_MAX_TOTAL);
    assert.deepEqual(body.messages.map((m: { truncated: boolean }) => m.truncated), [false, false, false, false, true]);
  });

  it("本文が空の通は truncated にしない。添付の情報は返さない", async () => {
    const f = fake({ details: { m1: detail("m1", { text: null, html: null, attachments: [{ filename: "a.pdf", mimeType: "application/pdf", size: 1, contentId: null, inline: false }] }) } });
    const body = parse(await get(f, ["m1"]));
    assert.equal(body.messages[0].truncated, false);
    assert.equal("attachments" in body.messages[0], false);
  });

  it("idsの個数・型が範囲外なら失敗、本人照合は検索と同じ", async () => {
    for (const ids of [[], ["1", "2", "3", "4", "5", "6"], [1], "m1", undefined]) {
      assert.equal((await get(fake({}), ids)).isError, true, JSON.stringify(ids));
    }
    const res = await createMailGetTool(fake({}).deps).handler({ ids: ["m1"] }, ctx({ subject: null }));
    assert.equal(res.isError, true);
    const other = await createMailGetTool(fake({ owner: "x@example.com" }).deps).handler({ ids: ["m1"] }, ctx());
    assert.equal(other.isError, true);
  });
});
