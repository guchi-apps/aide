import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { buildMimeMessage, loadGmailCredentials, loadImageMailRecipients, sendGmailMessage } from "./gmail.ts";

/** 実際のGmail API・Google OAuthエンドポイントへは接続しない。すべて fetch をモックする。 */

const ENV_NAMES = [
  "AIDE_GMAIL_CLIENT_ID",
  "AIDE_GMAIL_CLIENT_SECRET",
  "AIDE_GMAIL_REFRESH_TOKEN",
  "AIDE_IMAGE_MAIL_TO",
  "AIDE_IMAGE_MAIL_BCC",
] as const;

afterEach(() => {
  for (const name of ENV_NAMES) delete process.env[name];
});

describe("loadGmailCredentials", () => {
  it("3つとも揃っていれば読める", () => {
    process.env["AIDE_GMAIL_CLIENT_ID"] = "id";
    process.env["AIDE_GMAIL_CLIENT_SECRET"] = "secret";
    process.env["AIDE_GMAIL_REFRESH_TOKEN"] = "token";
    assert.deepEqual(loadGmailCredentials(), { clientId: "id", clientSecret: "secret", refreshToken: "token" });
  });

  it("1つでも欠けていれば null", () => {
    process.env["AIDE_GMAIL_CLIENT_ID"] = "id";
    assert.equal(loadGmailCredentials(), null);
  });
});

describe("loadImageMailRecipients", () => {
  it("TOが無ければ null（口が開かない）", () => {
    assert.equal(loadImageMailRecipients(), null);
  });

  it("カンマ区切りで複数の宛先・BCCを読む", () => {
    process.env["AIDE_IMAGE_MAIL_TO"] = "a@example.com, b@example.com";
    process.env["AIDE_IMAGE_MAIL_BCC"] = "c@example.com";
    const recipients = loadImageMailRecipients();
    assert.deepEqual(recipients, { to: ["a@example.com", "b@example.com"], bcc: ["c@example.com"] });
  });

  it("BCC未設定なら空配列", () => {
    process.env["AIDE_IMAGE_MAIL_TO"] = "a@example.com";
    const recipients = loadImageMailRecipients();
    assert.deepEqual(recipients, { to: ["a@example.com"], bcc: [] });
  });
});

describe("buildMimeMessage", () => {
  it("件名がRFC2047でエンコードされ、添付のbase64を復号すると元のバイト列に戻る", () => {
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0xfe]);
    const raw = buildMimeMessage({
      to: ["to@example.com"],
      bcc: ["bcc@example.com"],
      subject: "[画像] テスト",
      bodyText: "本文です",
      attachment: { filename: "images.zip", contentType: "application/zip", data: zip },
    });

    assert.match(raw, /^To: to@example\.com\r\n/);
    assert.match(raw, /Bcc: bcc@example\.com\r\n/);
    const subjectMatch = /Subject: =\?UTF-8\?B\?([^?]+)\?=/.exec(raw);
    assert.ok(subjectMatch);
    assert.equal(Buffer.from(subjectMatch[1]!, "base64").toString("utf8"), "[画像] テスト");

    // 添付のbase64本文を取り出し、復号して元のZIPバイト列と一致することを確かめる。
    const attachmentMatch = /Content-Disposition: attachment; filename="images\.zip"\r\n\r\n([\s\S]+?)\r\n--/.exec(raw);
    assert.ok(attachmentMatch);
    const decoded = Buffer.from(attachmentMatch[1]!.replace(/\r\n/g, ""), "base64");
    assert.ok(decoded.equals(zip));
  });

  it("ASCIIのみで構成される（base64エンコードのため）", () => {
    const raw = buildMimeMessage({
      to: ["to@example.com"],
      bcc: [],
      subject: "日本語件名",
      bodyText: "日本語本文",
      attachment: { filename: "images.zip", contentType: "application/zip", data: Buffer.from([0x00, 0xff]) },
    });
    assert.ok(/^[\x00-\x7f]*$/.test(raw));
  });
});

describe("sendGmailMessage", () => {
  const credentials = { clientId: "id", clientSecret: "secret", refreshToken: "token" };
  const input = {
    to: ["to@example.com"],
    bcc: [],
    subject: "[画像] テスト",
    bodyText: "本文",
    attachment: { filename: "images.zip", contentType: "application/zip", data: Buffer.from("zip") },
  };

  it("成功: token取得→送信の2段階を呼び、messageIdを返す", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      calls.push(String(url));
      if (String(url).includes("oauth2.googleapis.com")) {
        return new Response(JSON.stringify({ access_token: "at" }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "msg-1" }), { status: 200 });
    }) as typeof fetch;

    const outcome = await sendGmailMessage(credentials, input, fetchImpl);
    assert.deepEqual(outcome, { ok: true, messageId: "msg-1" });
    assert.equal(calls.length, 2);
  });

  it("トークン取得が401: unauthorized（送信は試みない）", async () => {
    let sendCalled = false;
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).includes("oauth2.googleapis.com")) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 });
      }
      sendCalled = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const outcome = await sendGmailMessage(credentials, input, fetchImpl);
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.kind, "unauthorized");
    assert.equal(sendCalled, false);
  });

  it("送信が400: rejected", async () => {
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).includes("oauth2.googleapis.com")) {
        return new Response(JSON.stringify({ access_token: "at" }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "invalid" }), { status: 400 });
    }) as typeof fetch;

    const outcome = await sendGmailMessage(credentials, input, fetchImpl);
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.kind, "rejected");
  });

  it("送信が500: failed（送信されたか不明）", async () => {
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).includes("oauth2.googleapis.com")) {
        return new Response(JSON.stringify({ access_token: "at" }), { status: 200 });
      }
      return new Response("error", { status: 500 });
    }) as typeof fetch;

    const outcome = await sendGmailMessage(credentials, input, fetchImpl);
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.kind, "failed");
  });
});
