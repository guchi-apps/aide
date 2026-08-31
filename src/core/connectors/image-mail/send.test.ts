import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const dir = await mkdtemp(join(tmpdir(), "aide-image-mail-send-test-"));
process.env["AIDE_IMAGE_MAIL_IDEMPOTENCY_LOG_PATH"] = join(dir, "image-mail-idempotency.json");
process.env["AIDE_IMAGE_MAIL_LOG_PATH"] = join(dir, "image-mail-log.json");
const { sendImageMail } = await import("./send.ts");
const { IMAGE_MAIL_LOG_PATH } = await import("./log.ts");

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const credentials = { clientId: "id", clientSecret: "secret", refreshToken: "token" };
const recipients = { to: ["to@example.com"], bcc: [] };

function baseInput(idempotencyKey: string) {
  return {
    idempotencyKey,
    title: "テスト",
    imageCount: 3,
    width: 1200 as const,
    zip: Buffer.from("zip-content"),
  };
}

function fetchImplFor(sendStatus: number, sendBody: unknown): typeof fetch {
  return (async (url: string | URL) => {
    if (String(url).includes("oauth2.googleapis.com")) {
      return new Response(JSON.stringify({ access_token: "at" }), { status: 200 });
    }
    return new Response(JSON.stringify(sendBody), { status: sendStatus });
  }) as typeof fetch;
}

async function readLog(): Promise<unknown[]> {
  return JSON.parse(await readFile(IMAGE_MAIL_LOG_PATH, "utf8")) as unknown[];
}

describe("sendImageMail", () => {
  it("成功: messageIdを返し、ログに記録される", async () => {
    const outcome = await sendImageMail(
      credentials,
      recipients,
      baseInput("send-1"),
      fetchImplFor(200, { id: "msg-1" }),
    );
    assert.deepEqual(outcome, { ok: true, messageId: "msg-1", duplicated: false });

    const log = (await readLog()) as { ok: boolean; messageId: string | null; imageCount: number }[];
    const entry = log.find((e) => e.messageId === "msg-1");
    assert.ok(entry);
    assert.equal(entry.ok, true);
    assert.equal(entry.imageCount, 3);
  });

  it("同じidempotencyKeyで再送すると、Gmailへ送らずduplicated:trueを返す", async () => {
    let sendCalls = 0;
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).includes("oauth2.googleapis.com")) {
        return new Response(JSON.stringify({ access_token: "at" }), { status: 200 });
      }
      sendCalls += 1;
      return new Response(JSON.stringify({ id: "msg-2" }), { status: 200 });
    }) as typeof fetch;

    const first = await sendImageMail(credentials, recipients, baseInput("send-2"), fetchImpl);
    assert.equal(first.ok, true);
    const second = await sendImageMail(credentials, recipients, baseInput("send-2"), fetchImpl);
    assert.deepEqual(second, { ok: true, messageId: "msg-2", duplicated: true });
    assert.equal(sendCalls, 1);
  });

  it("rejected（Gmailが拒否）は記録を消し、次回同じキーで再試行できる", async () => {
    const rejected = await sendImageMail(
      credentials,
      recipients,
      baseInput("send-3"),
      fetchImplFor(400, { error: "invalid" }),
    );
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.kind, "rejected");

    // abandon 済みなので次回は new として扱われ、conflict にならない。
    const retried = await sendImageMail(
      credentials,
      recipients,
      baseInput("send-3"),
      fetchImplFor(200, { id: "msg-3" }),
    );
    assert.deepEqual(retried, { ok: true, messageId: "msg-3", duplicated: false });
  });

  it("failed（送信されたか不明）は記録を残し、次回同じキーはconflictになる", async () => {
    const failed = await sendImageMail(
      credentials,
      recipients,
      baseInput("send-4"),
      fetchImplFor(500, "error"),
    );
    assert.equal(failed.ok, false);
    if (!failed.ok) assert.equal(failed.kind, "failed");

    const retried = await sendImageMail(
      credentials,
      recipients,
      baseInput("send-4"),
      fetchImplFor(200, { id: "msg-4" }),
    );
    assert.equal(retried.ok, false);
    if (!retried.ok) assert.equal(retried.kind, "conflict");
  });
});
