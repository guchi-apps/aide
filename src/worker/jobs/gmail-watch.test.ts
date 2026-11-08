import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readGmailWatchTopic, runGmailWatch } from "./gmail-watch.ts";

const credentials = { clientId: "id", clientSecret: "secret", refreshToken: "refresh" };
const TOPIC = "projects/p/topics/t";

function fakeFetch(watch: () => Response): { fetchImpl: typeof fetch; calls: { url: string; body: string | undefined }[] } {
  const calls: { url: string; body: string | undefined }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
    if (url.startsWith("https://oauth2.googleapis.com/token")) return Response.json({ access_token: "access" });
    if (url.endsWith("/users/me/watch")) return watch();
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("readGmailWatchTopic", () => {
  it("未設定・空白だけなら null", () => {
    assert.equal(readGmailWatchTopic({}), null);
    assert.equal(readGmailWatchTopic({ AIDE_GMAIL_WATCH_TOPIC: "  " }), null);
    assert.equal(readGmailWatchTopic({ AIDE_GMAIL_WATCH_TOPIC: ` ${TOPIC} ` }), TOPIC);
  });
});

describe("runGmailWatch", () => {
  it("トピック未設定ならGmailを呼ばない", async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response("{}"));
    const message = await runGmailWatch({ topic: null, credentials, fetchImpl });
    assert.match(message, /未設定/);
    assert.equal(calls.length, 0);
  });

  it("INBOXとトピックを指定してwatchをかける", async () => {
    const { fetchImpl, calls } = fakeFetch(() => Response.json({ historyId: "1", expiration: "1700000000000" }));
    const message = await runGmailWatch({ topic: TOPIC, credentials, fetchImpl });
    assert.match(message, /2023-11-14T22:13:20.000Z/);
    const watchCall = calls.find((c) => c.url.endsWith("/watch"));
    assert.deepEqual(JSON.parse(watchCall!.body!), { labelIds: ["INBOX"], labelFilterBehavior: "INCLUDE", topicName: TOPIC });
  });

  it("失敗は例外にし、Googleのメッセージを添える", async () => {
    const { fetchImpl } = fakeFetch(
      () => new Response(JSON.stringify({ error: { message: "Invalid topicName does not match projects/x" } }), { status: 403 }),
    );
    await assert.rejects(runGmailWatch({ topic: TOPIC, credentials, fetchImpl }), /403.*Invalid topicName/);
  });

  it("トピック名の形が違う・資格情報が無いときは例外", async () => {
    await assert.rejects(runGmailWatch({ topic: "bad", credentials }), /projects/);
    await assert.rejects(runGmailWatch({ topic: TOPIC, credentials: null }), /資格情報/);
  });
});
