import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { beforeEach, describe, it } from "node:test";
import { resetRateLimits } from "../auth/ratelimit.ts";
import type { GmailInbox, ListQuery } from "../core/connectors/gmail-inbox/client.ts";
import {
  handleMailApiAction,
  handleMailApiList,
  handleMailApiMessage,
  isLabelId,
  isMessageId,
  messageIdFromPath,
  parseActionBody,
  parseListState,
  selectMailSource,
  toListQuery,
  type MailApiDeps,
} from "./mail.ts";

const TOKEN = "test-mail-api-token";

function request(url: string, headers: Record<string, string>, body = "", method = "GET"): IncomingMessage {
  const stream = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
  stream.headers = headers;
  stream.url = url;
  stream.method = method;
  (stream as unknown as { socket: { remoteAddress: string } }).socket = { remoteAddress: "127.0.0.1" };
  return stream;
}

interface Captured {
  status?: number;
  body?: Record<string, unknown>;
}

function response(): ServerResponse & Captured {
  const res = {
    writeHead(status: number) {
      res.status = status;
      return res;
    },
    end(text?: string) {
      res.body = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
      return res;
    },
  } as unknown as ServerResponse & Captured;
  return res;
}

const auth = { authorization: `Bearer ${TOKEN}` };

function summary(id: string, receivedAt: number) {
  return { id, threadId: id, from: "a@example.com", subject: "s", snippet: "", receivedAt, labelIds: ["INBOX"], unread: true, starred: false };
}

function fakeDeps(record: { queries: ListQuery[]; applied: unknown[] }, overrides: Partial<MailApiDeps> = {}): MailApiDeps {
  const connect = (async () => ({
    ok: true,
    value: {
      kind: "gmail",
      supportsLabels: true,
      profileEmail: async () => ({ ok: true, value: "Me@Example.com" }),
      labels: async () => ({ ok: true, value: [{ id: "Label_1", name: "仕事", type: "user" }] }),
      list: async (query: ListQuery) => {
        record.queries.push(query);
        return { ok: true, value: { messages: [summary("old1", 1_000), summary("new1", 5_000)], nextPageToken: "p2", resultSizeEstimate: 2 } };
      },
      get: async (id: string) =>
        id === "missing"
          ? { ok: false, kind: "not_found", reason: "" }
          : { ok: true, value: { ...summary(id, 5_000), to: "", cc: "", html: "<p>hi</p>", text: "hi", attachments: [] } },
      apply: async (ids: string[], action: string, label: string | null) => {
        record.applied.push({ ids, action, label });
        return { ok: true, value: undefined };
      },
    },
  })) as unknown as typeof GmailInbox.connect;
  return { connect, source: "gmail", token: async () => TOKEN, failureDelayMs: 0, ...overrides };
}

describe("Morrow向けメールAPI（#795）", () => {
  let record: { queries: ListQuery[]; applied: unknown[] };
  beforeEach(() => {
    resetRateLimits();
    record = { queries: [], applied: [] };
  });

  it("トークンが未設定なら503で閉じ、取得元へつながない", async () => {
    const res = response();
    await handleMailApiList(request("/api/mail/messages", auth), res, fakeDeps(record, { token: async () => null }));
    assert.equal(res.status, 503);
    assert.equal(record.queries.length, 0);
  });

  it("トークンが違えば401で、取得元へつながない", async () => {
    const res = response();
    await handleMailApiList(request("/api/mail/messages", { authorization: "Bearer wrong" }), res, fakeDeps(record));
    assert.equal(res.status, 401);
    assert.equal(record.queries.length, 0);
  });

  it("一覧は表示の種類を画面と同じ形で引き、持ち主のアドレスを小文字で載せる", async () => {
    const res = response();
    await handleMailApiList(request("/api/mail/messages?view=unread", auth), res, fakeDeps(record));
    assert.equal(res.status, 200);
    assert.deepEqual(record.queries[0]!.labelIds, ["INBOX", "UNREAD"]);
    assert.equal(res.body!["owner"], "me@example.com");
    assert.equal(res.body!["view"], "unread");
    assert.equal(res.body!["nextPageToken"], "p2");
    assert.equal((res.body!["messages"] as unknown[]).length, 2);
  });

  it("一部のアカウントが読めなかったときは partial と failedAccounts を返す（#801）", async () => {
    const base = fakeDeps(record);
    const deps: MailApiDeps = {
      ...base,
      connect: (async (d: MailApiDeps) => {
        const m = (await (base.connect as unknown as (d: MailApiDeps) => Promise<{ value: Record<string, unknown> }>)(d)).value;
        const list = m["list"] as (q: ListQuery) => Promise<{ value: Record<string, unknown> }>;
        return {
          ok: true,
          value: {
            ...m,
            list: async (q: ListQuery) => {
              const r = await list(q);
              return { ok: true, value: { ...r.value, failedAccounts: ["サブ"] } };
            },
          },
        };
      }) as unknown as typeof GmailInbox.connect,
    };
    const res = response();
    await handleMailApiList(request("/api/mail/messages", auth), res, deps);
    assert.equal(res.status, 200);
    assert.equal(res.body!["partial"], true);
    assert.deepEqual(res.body!["failedAccounts"], ["サブ"]);

    const full = response();
    await handleMailApiList(request("/api/mail/messages", auth), full, fakeDeps(record));
    assert.equal(full.body!["partial"], false);
    assert.deepEqual(full.body!["failedAccounts"], []);
    // 単一アカウントの構成では accounts を載せない（#821）。
    assert.equal("accounts" in full.body!, false);
  });

  it("since を付けると、受信がそれ以降のものだけを返す", async () => {
    const res = response();
    await handleMailApiList(request("/api/mail/messages?since=3000", auth), res, fakeDeps(record));
    assert.deepEqual(
      (res.body!["messages"] as { id: string }[]).map((m) => m.id),
      ["new1"],
    );
  });

  it("本文はパスのIDで引き、見つからなければ404", async () => {
    const ok = response();
    await handleMailApiMessage(request("/api/mail/messages/abc123", auth), ok, "/api/mail/messages/abc123", fakeDeps(record));
    assert.equal(ok.status, 200);
    assert.equal((ok.body!["message"] as { id: string }).id, "abc123");

    const missing = response();
    await handleMailApiMessage(request("/api/mail/messages/missing", auth), missing, "/api/mail/messages/missing", fakeDeps(record));
    assert.equal(missing.status, 404);
  });

  it("本文もトークンが違えば401で、取得元へつながない", async () => {
    let connected = false;
    const deps = fakeDeps(record, {
      connect: (async () => {
        connected = true;
        return { ok: false, kind: "failed", reason: "" };
      }) as unknown as MailApiDeps["connect"],
    });
    const res = response();
    await handleMailApiMessage(request("/api/mail/messages/abc", { authorization: "Bearer x" }), res, "/api/mail/messages/abc", deps);
    assert.equal(res.status, 401);
    assert.equal(connected, false);
  });

  it("パスのIDは形を確かめる", () => {
    assert.equal(messageIdFromPath("/api/mail/messages/abc.1.2"), "abc.1.2");
    assert.equal(messageIdFromPath("/api/mail/messages/a%2Fb"), null);
    assert.equal(messageIdFromPath("/api/mail/messages/a/b"), null);
    assert.equal(messageIdFromPath("/api/mail/messages/%E0%A4%A"), null);
  });

  it("操作はJSONで受け、重複したIDをまとめて取得元へ渡す", async () => {
    const res = response();
    const body = JSON.stringify({ action: "archive", ids: ["a1", "a1", "b2"] });
    await handleMailApiAction(request("/api/mail/actions", auth, body, "POST"), res, fakeDeps(record));
    assert.equal(res.status, 200);
    assert.deepEqual(record.applied, [{ ids: ["a1", "b2"], action: "archive", label: null }]);
    assert.equal(res.body!["count"], 2);
  });

  it("持たない操作・不正なID・ラベル無しのラベル操作は400で、何もしない", async () => {
    for (const body of [
      { action: "delete", ids: ["a1"] },
      { action: "archive", ids: [] },
      { action: "archive", ids: ["a/1"] },
      { action: "label-add", ids: ["a1"] },
    ]) {
      const res = response();
      await handleMailApiAction(request("/api/mail/actions", auth, JSON.stringify(body), "POST"), res, fakeDeps(record));
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.deepEqual(record.applied, []);
  });

  it("操作もトークンが違えば401で何もしない", async () => {
    const res = response();
    const body = JSON.stringify({ action: "trash", ids: ["a1"] });
    await handleMailApiAction(request("/api/mail/actions", { authorization: "Bearer x" }, body, "POST"), res, fakeDeps(record));
    assert.equal(res.status, 401);
    assert.deepEqual(record.applied, []);
  });

  it("ラベル操作はラベルIDを付けて受ける", () => {
    assert.deepEqual(parseActionBody({ action: "label-add", ids: ["a1"], labelId: "Label_1" }), {
      action: "label-add",
      ids: ["a1"],
      labelId: "Label_1",
    });
  });
});

describe("一覧の条件（旧メール画面から移動）", () => {
  it("タブ・ラベル・検索・ページを読み、検索条件へ写す", () => {
    const state = parseListState(new URLSearchParams("view=unread&q=%20from%3Ax%20&page=123"));
    assert.equal(state.view.key, "unread");
    assert.equal(state.q, "from:x");
    assert.deepEqual(toListQuery(state).labelIds, ["INBOX", "UNREAD"]);
  });

  it("ユーザーラベルで絞ると、そのラベルだけを条件にする。不正な値は捨てる", () => {
    assert.deepEqual(toListQuery(parseListState(new URLSearchParams("label=Label_5"))).labelIds, ["Label_5"]);
    const bad = parseListState(new URLSearchParams("label=a%20b&page=x%2Fy&view=nope"));
    assert.equal(bad.labelId, null);
    assert.equal(bad.pageToken, null);
    assert.equal(bad.view.key, "inbox");
  });

  it("ゴミ箱だけ includeSpamTrash を付ける", () => {
    assert.equal(toListQuery(parseListState(new URLSearchParams("view=trash"))).includeSpamTrash, true);
    assert.equal(toListQuery(parseListState(new URLSearchParams(""))).includeSpamTrash, false);
  });

  it("IMAPのメッセージID・フォルダのラベルIDを受け、危険な文字は受けない", () => {
    assert.ok(isMessageId("SU5CT1g.7.42"));
    assert.ok(isLabelId("F5LuL5LqL"));
    assert.ok(!isMessageId("../etc/passwd"));
    assert.ok(!isMessageId("a/b"));
    assert.ok(!isLabelId("a b"));
  });
});

describe("取得元の選択（#782）", () => {
  const names = ["AIDE_MAIL_SOURCE", "AIDE_GMAIL_CLIENT_ID", "AIDE_GMAIL_CLIENT_SECRET", "AIDE_GMAIL_INBOX_REFRESH_TOKEN", "AIDE_IMAP_HOST", "AIDE_IMAP_USER", "AIDE_IMAP_PASSWORD"];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  const reset = () => {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  };

  it("取得元: 明示 > Gmailのトークン > IMAPの接続情報 > Gmail（未設定）", () => {
    try {
      for (const n of names) delete process.env[n];
      assert.equal(selectMailSource(), "gmail");
      process.env["AIDE_IMAP_HOST"] = "imap.example.com";
      process.env["AIDE_IMAP_USER"] = "me@example.com";
      process.env["AIDE_IMAP_PASSWORD"] = "pw";
      assert.equal(selectMailSource(), "imap");
      process.env["AIDE_GMAIL_CLIENT_ID"] = "id";
      process.env["AIDE_GMAIL_CLIENT_SECRET"] = "secret";
      process.env["AIDE_GMAIL_INBOX_REFRESH_TOKEN"] = "token";
      assert.equal(selectMailSource(), "gmail");
      process.env["AIDE_MAIL_SOURCE"] = "imap";
      assert.equal(selectMailSource(), "imap");
    } finally {
      reset();
    }
  });
});
