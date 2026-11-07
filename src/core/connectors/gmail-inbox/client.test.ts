import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { GmailInbox, labelChangeFor, loadGmailInboxCredentials } from "./client.ts";

const credentials = { clientId: "id", clientSecret: "secret", refreshToken: "refresh" };

interface Call {
  url: string;
  method: string;
  body: string | undefined;
}

/** トークン取得と Gmail API を差し替える。`routes` は URL の一部に一致した最初の応答を返す。 */
function fakeFetch(routes: [string, () => Response][]): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return Response.json({ access_token: "access" });
    }
    const route = routes.find(([part]) => url.includes(part));
    return route ? route[1]() : new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("loadGmailInboxCredentials", () => {
  const names = ["AIDE_GMAIL_CLIENT_ID", "AIDE_GMAIL_CLIENT_SECRET", "AIDE_GMAIL_INBOX_REFRESH_TOKEN", "AIDE_GMAIL_REFRESH_TOKEN"];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  afterEach(() => {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  });

  it("送信用のリフレッシュトークンでは代わりにならない（条件2）", () => {
    process.env["AIDE_GMAIL_CLIENT_ID"] = "id";
    process.env["AIDE_GMAIL_CLIENT_SECRET"] = "secret";
    process.env["AIDE_GMAIL_REFRESH_TOKEN"] = "send-token";
    delete process.env["AIDE_GMAIL_INBOX_REFRESH_TOKEN"];
    assert.equal(loadGmailInboxCredentials(), null);
    process.env["AIDE_GMAIL_INBOX_REFRESH_TOKEN"] = "inbox-token";
    assert.equal(loadGmailInboxCredentials()?.refreshToken, "inbox-token");
  });
});

describe("labelChangeFor", () => {
  it("操作をラベルの付け外しへ写す", () => {
    assert.deepEqual(labelChangeFor("read", null), { addLabelIds: [], removeLabelIds: ["UNREAD"] });
    assert.deepEqual(labelChangeFor("archive", null), { addLabelIds: [], removeLabelIds: ["INBOX"] });
    assert.deepEqual(labelChangeFor("label-add", "Label_1"), { addLabelIds: ["Label_1"], removeLabelIds: [] });
    assert.equal(labelChangeFor("label-add", null), null);
    assert.equal(labelChangeFor("trash", null), null);
  });
});

describe("GmailInbox", () => {
  it("資格情報が無ければ unconfigured", async () => {
    const result = await GmailInbox.connect({ credentials: null });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.kind, "unconfigured");
  });

  it("トークンが失効していれば unauthorized", async () => {
    const fetchImpl = (async () => new Response("bad", { status: 400 })) as typeof fetch;
    const result = await GmailInbox.connect({ credentials, fetchImpl });
    assert.equal(!result.ok && result.kind, "unauthorized");
  });

  it("一覧はIDの順を保ってメタデータを集め、途中で消えたものは飛ばす", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["/messages?", () => Response.json({ messages: [{ id: "a1" }, { id: "b2" }, { id: "c3" }], nextPageToken: "next" })],
      ["/messages/a1?", () => Response.json({ id: "a1", labelIds: ["INBOX"], payload: { headers: [{ name: "Subject", value: "A" }] } })],
      ["/messages/c3?", () => Response.json({ id: "c3", labelIds: ["INBOX"], payload: { headers: [{ name: "Subject", value: "C" }] } })],
    ]);
    const inbox = await GmailInbox.connect({ credentials, fetchImpl });
    assert.ok(inbox.ok);
    const page = await inbox.value.list({ labelIds: ["INBOX", "UNREAD"], q: "from:x", pageToken: null, includeSpamTrash: false });
    assert.ok(page.ok);
    assert.deepEqual(page.value.messages.map((m) => m.subject), ["A", "C"]);
    assert.equal(page.value.nextPageToken, "next");
    const listUrl = new URL(calls.find((c) => c.url.includes("/messages?"))!.url);
    assert.deepEqual(listUrl.searchParams.getAll("labelIds"), ["INBOX", "UNREAD"]);
    assert.equal(listUrl.searchParams.get("q"), "from:x");
  });

  it("ラベル系の操作は batchModify を1回、ゴミ箱は1件ずつ trash を呼ぶ。完全削除は呼ばない", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["/messages/batchModify", () => new Response(null, { status: 204 })],
      ["/trash", () => Response.json({})],
    ]);
    const inbox = await GmailInbox.connect({ credentials, fetchImpl });
    assert.ok(inbox.ok);

    assert.ok((await inbox.value.apply(["a1", "b2"], "archive", null)).ok);
    const batch = calls.find((c) => c.url.endsWith("/messages/batchModify"))!;
    assert.equal(batch.method, "POST");
    assert.deepEqual(JSON.parse(batch.body!), { ids: ["a1", "b2"], addLabelIds: [], removeLabelIds: ["INBOX"] });

    assert.ok((await inbox.value.apply(["a1", "b2"], "trash", null)).ok);
    assert.deepEqual(
      calls.filter((c) => c.url.endsWith("/trash")).map((c) => c.url.split("/messages/")[1]),
      ["a1/trash", "b2/trash"],
    );
    assert.ok(calls.every((c) => c.method !== "DELETE"));
  });
});
