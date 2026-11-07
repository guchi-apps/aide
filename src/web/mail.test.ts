import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import type { GmailInbox } from "../core/connectors/gmail-inbox/client.ts";
import type { MailDetail } from "../core/connectors/gmail-inbox/message.ts";
import type { LoginOptions } from "./login.ts";
import {
  emailSrcdoc,
  formatListDate,
  handleMailAction,
  hasRemoteImages,
  isSameOriginPost,
  listHref,
  openMailbox,
  parseListState,
  renderMailDetail,
  renderMailList,
  safeMailBack,
  toListQuery,
} from "./mail.ts";

const options = {
  authConfig: { enabled: true },
  supabase: null,
  baseUrl: "https://aide.example.com",
  registry: {},
} as unknown as LoginOptions;

function request(headers: Record<string, string>, body = ""): IncomingMessage {
  const stream = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
  stream.headers = headers;
  return stream;
}

function response(): ServerResponse & { status?: number; location?: string } {
  const res = {
    writeHead(status: number, headers: Record<string, string> = {}) {
      res.status = status;
      res.location = headers["Location"];
      return res;
    },
    end() {
      return res;
    },
  } as unknown as ServerResponse & { status?: number; location?: string };
  return res;
}

describe("safeMailBack", () => {
  it("メール画面の中だけを戻り先に許す", () => {
    assert.equal(safeMailBack("/mail?view=unread&q=a"), "/mail?view=unread&q=a");
    assert.equal(safeMailBack("/mail/message?id=abc&back=%2Fmail"), "/mail/message?id=abc&back=%2Fmail");
    assert.equal(safeMailBack("//evil.example.com/mail"), "/mail");
    assert.equal(safeMailBack("https://evil.example.com"), "/mail");
    assert.equal(safeMailBack("/mailx"), "/mail");
    assert.equal(safeMailBack("/map"), "/mail");
    assert.equal(safeMailBack(null), "/mail");
  });
});

describe("isSameOriginPost", () => {
  it("Origin がAIDE自身のときだけ通す", () => {
    assert.equal(isSameOriginPost(request({ origin: "https://aide.example.com" }), options.baseUrl), true);
    assert.equal(isSameOriginPost(request({ origin: "https://other.example.com" }), options.baseUrl), false);
    assert.equal(isSameOriginPost(request({ "sec-fetch-site": "same-site" }), options.baseUrl), false);
    assert.equal(isSameOriginPost(request({ "sec-fetch-site": "same-origin" }), options.baseUrl), true);
    assert.equal(isSameOriginPost(request({}), options.baseUrl), false);
  });
});

describe("一覧の状態", () => {
  it("タブ・ラベル・検索・ページを読み、URLへ戻す", () => {
    const state = parseListState(new URLSearchParams("view=unread&q=%20from%3Ax%20&page=123"));
    assert.equal(state.view.key, "unread");
    assert.equal(state.q, "from:x");
    assert.deepEqual(toListQuery(state).labelIds, ["INBOX", "UNREAD"]);
    assert.equal(listHref(state), "/mail?view=unread&q=from%3Ax&page=123");
    assert.equal(listHref(state, { pageToken: null }), "/mail?view=unread&q=from%3Ax");
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
});

describe("formatListDate", () => {
  it("今日なら時刻、それ以外は日付", () => {
    const now = new Date("2026-11-07T12:00:00+09:00");
    assert.equal(formatListDate(new Date("2026-11-07T09:05:00+09:00").getTime(), now), "09:05");
    assert.equal(formatListDate(new Date("2026-11-01T09:05:00+09:00").getTime(), now), "2026/11/01");
  });
});

describe("HTMLメールの閉じ込め", () => {
  it("既定では外部画像を許さず、押したときだけ https: を許す", () => {
    assert.match(emailSrcdoc("<p>x</p>", false), /img-src data:;/);
    assert.match(emailSrcdoc("<p>x</p>", true), /img-src data: https:;/);
    assert.match(emailSrcdoc("<p>x</p>", false), /default-src 'none'/);
  });

  it("外部画像の有無を見分ける", () => {
    assert.equal(hasRemoteImages('<img src="https://t.example.com/p.gif">'), true);
    assert.equal(hasRemoteImages('<div style="background:url(https://x/y.png)">'), true);
    assert.equal(hasRemoteImages('<img src="data:image/png;base64,AAAA">'), false);
  });
});

const detail: MailDetail = {
  id: "abc123",
  threadId: "abc123",
  from: '"<script>" <x@example.com>',
  subject: "<b>件名</b>",
  snippet: "",
  receivedAt: null,
  labelIds: ["INBOX", "UNREAD", "Label_1"],
  unread: true,
  starred: false,
  to: "me@example.com",
  cc: "",
  html: '<p>本文</p><img src="https://tracker.example.com/o.gif">',
  text: null,
  attachments: [],
};
const labels = [
  { id: "INBOX", name: "INBOX", type: "system" as const },
  { id: "Label_1", name: "仕事", type: "user" as const },
  { id: "Label_2", name: "家計", type: "user" as const },
];

describe("renderMailDetail", () => {
  const html = renderMailDetail({
    message: detail,
    labels,
    failure: null,
    back: "/mail",
    showImages: false,
    params: new URLSearchParams(),
    headerAction: "",
    authEnabled: true,
  });

  it("件名・差出人をエスケープし、本文はスクリプト不可の枠に入れる", () => {
    assert.ok(html.includes("&lt;b&gt;件名&lt;/b&gt;"));
    assert.ok(!html.includes("<script>"));
    assert.match(html, /<iframe class="mail-body"[^>]*sandbox="allow-popups allow-popups-to-escape-sandbox"/);
    assert.ok(!/sandbox="[^"]*allow-scripts/.test(html));
    assert.ok(!/sandbox="[^"]*allow-same-origin/.test(html));
  });

  it("未読なら既読ボタン、付いているラベルの外す操作、付いていないラベルの追加を出す", () => {
    assert.ok(html.includes('value="read"'));
    assert.ok(html.includes("ラベル「仕事」を外す"));
    assert.ok(html.includes('<option value="Label_2">家計</option>'));
    assert.ok(!html.includes('<option value="Label_1">'));
    assert.ok(html.includes("画像を表示"));
  });
});

describe("renderMailList", () => {
  it("未設定なら案内だけを出す", () => {
    const html = renderMailList({
      state: parseListState(new URLSearchParams()),
      labels: [],
      page: null,
      failure: "unconfigured",
      params: new URLSearchParams(),
      headerAction: "",
      authEnabled: true,
      now: new Date(),
    });
    assert.ok(html.includes("AIDE_GMAIL_INBOX_REFRESH_TOKEN"));
    assert.ok(!html.includes('action="/mail/action"'));
  });

  it("行の件名をエスケープし、一括操作のフォームを出す", () => {
    const html = renderMailList({
      state: parseListState(new URLSearchParams()),
      labels,
      page: { messages: [{ ...detail }], nextPageToken: "n1", resultSizeEstimate: 1 },
      failure: null,
      params: new URLSearchParams("done=archive&n=3"),
      headerAction: "",
      authEnabled: true,
      now: new Date(),
    });
    assert.ok(html.includes("&lt;b&gt;件名&lt;/b&gt;"));
    assert.ok(html.includes('name="id" value="abc123"'));
    assert.ok(html.includes("アーカイブしました（3件）"));
    assert.ok(html.includes("/mail?page=n1"));
    assert.ok(html.includes(">仕事</a>"));
  });
});

describe("openMailbox", () => {
  const connectAs = (owner: string) =>
    (async () => ({
      ok: true,
      value: { profileEmail: async () => ({ ok: true, value: owner }) },
    })) as unknown as typeof GmailInbox.connect;

  it("Gmailの認可アカウントと同じアドレスのときだけ開ける（大文字小文字は区別しない）", async () => {
    assert.equal((await openMailbox({ email: "Me@Example.com", sub: "1" }, { connect: connectAs("me@example.com") })).ok, true);
    const other = await openMailbox({ email: "family@example.com", sub: "2" }, { connect: connectAs("me@example.com") });
    assert.equal(!other.ok && other.kind, "not_owner");
  });

  it("メールアドレスの無いセッションは、Gmailへつなぐ前に断る", async () => {
    let connected = false;
    const connect = (async () => {
      connected = true;
      return { ok: false, kind: "failed", reason: "" };
    }) as unknown as typeof GmailInbox.connect;
    const result = await openMailbox({ email: null, sub: null }, { connect });
    assert.equal(!result.ok && result.kind, "not_owner");
    assert.equal(connected, false);
  });
});

describe("handleMailAction", () => {
  function fakeInbox(applied: unknown[], owner = "me@example.com"): typeof GmailInbox.connect {
    return (async () => ({
      ok: true,
      value: {
        profileEmail: async () => ({ ok: true, value: owner }),
        apply: async (ids: string[], action: string, label: string | null) => {
          applied.push({ ids, action, label });
          return { ok: true, value: undefined };
        },
      },
    })) as unknown as typeof GmailInbox.connect;
  }
  const session = async () => ({ email: "me@example.com", sub: "1" });

  it("選んだメールへ操作を適用し、元の画面へ結果付きで戻す", async () => {
    const applied: unknown[] = [];
    const res = response();
    await handleMailAction(
      request({ origin: "https://aide.example.com" }, "id=a1&id=b2&id=..%2F&action=archive&back=%2Fmail%3Fview%3Dunread"),
      res,
      options,
      { connect: fakeInbox(applied), currentSession: session },
    );
    assert.deepEqual(applied, [{ ids: ["a1", "b2"], action: "archive", label: null }]);
    assert.equal(res.status, 303);
    assert.equal(res.location, "/mail?view=unread&done=archive&n=2");
  });

  it("本文画面からアーカイブしたら一覧へ戻す", async () => {
    const res = response();
    await handleMailAction(
      request(
        { origin: "https://aide.example.com" },
        "id=a1&action=archive&back=%2Fmail%2Fmessage%3Fid%3Da1&list=%2Fmail%3Fview%3Dstarred",
      ),
      res,
      options,
      { connect: fakeInbox([]), currentSession: session },
    );
    assert.equal(res.location, "/mail?view=starred&done=archive&n=1");
  });

  it("別のサイトからの送信は何もせず 403", async () => {
    const applied: unknown[] = [];
    const res = response();
    await handleMailAction(request({ origin: "https://evil.example.com" }, "id=a1&action=trash"), res, options, {
      connect: fakeInbox(applied),
      currentSession: session,
    });
    assert.equal(res.status, 403);
    assert.deepEqual(applied, []);
  });

  it("持ち主以外のログインでは何もせず、断った旨を付けて戻す", async () => {
    const applied: unknown[] = [];
    const res = response();
    await handleMailAction(request({ origin: "https://aide.example.com" }, "id=a1&action=trash&back=%2Fmail"), res, options, {
      connect: fakeInbox(applied, "owner@example.com"),
      currentSession: session,
    });
    assert.deepEqual(applied, []);
    assert.equal(res.location, "/mail?error=not_owner");
  });

  it("メールアドレスを持たないセッション（認証無効・パスワード）では何もしない", async () => {
    const applied: unknown[] = [];
    const res = response();
    await handleMailAction(request({ origin: "https://aide.example.com" }, "id=a1&action=trash&back=%2Fmail"), res, options, {
      connect: fakeInbox(applied),
      currentSession: async () => ({ email: null, sub: null }),
    });
    assert.deepEqual(applied, []);
    assert.equal(res.location, "/mail?error=not_owner");
  });

  it("未ログインなら何もせず一覧へ", async () => {
    const applied: unknown[] = [];
    const res = response();
    await handleMailAction(request({ origin: "https://aide.example.com" }, "id=a1&action=trash"), res, options, {
      connect: fakeInbox(applied),
      currentSession: async () => null,
    });
    assert.equal(res.location, "/mail");
    assert.deepEqual(applied, []);
  });

  it("知らない操作・外部の戻り先は受け付けない", async () => {
    const applied: unknown[] = [];
    const res = response();
    await handleMailAction(
      request({ origin: "https://aide.example.com" }, "id=a1&action=delete&back=https%3A%2F%2Fevil.example.com"),
      res,
      options,
      { connect: fakeInbox(applied), currentSession: session },
    );
    assert.deepEqual(applied, []);
    assert.equal(res.location, "/mail");
  });
});
