import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { charsetOf, decodeBody, decodeSnippet, displayName, toDetail, toSummary } from "./message.ts";

function b64url(bytes: Buffer | string): string {
  return Buffer.from(bytes).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

describe("decodeBody", () => {
  it("UTF-8 の base64url を戻す", () => {
    assert.equal(decodeBody(b64url("こんにちは ?>"), "utf-8"), "こんにちは ?>");
  });

  it("ISO-2022-JP を charset どおりに読む", () => {
    // 「る」の ISO-2022-JP 表現
    assert.equal(decodeBody(b64url(Buffer.from("1b2442246b1b2842", "hex")), "iso-2022-jp"), "る");
  });

  it("Shift_JIS を読む", () => {
    assert.equal(decodeBody(b64url(Buffer.from("82a0", "hex")), "shift_jis"), "あ");
  });

  it("知らない charset は UTF-8 で読む", () => {
    assert.equal(decodeBody(b64url("abc"), "x-unknown-charset"), "abc");
  });

  it("Content-Type に charset が無くても、HTMLの meta の指定で読む", () => {
    const html = Buffer.concat([Buffer.from('<html><head><meta charset="Shift_JIS"></head><body>'), Buffer.from("82a0", "hex")]);
    assert.ok(decodeBody(b64url(html), null).endsWith("あ"));
  });

  it("charset が無く meta も無いShift_JISは、UTF-8で化けさせずに読む", () => {
    assert.equal(decodeBody(b64url(Buffer.from("82a082a2", "hex")), null), "あい");
  });

  it("charset が無いISO-2022-JPは、ESCを手掛かりに読む", () => {
    assert.equal(decodeBody(b64url(Buffer.from("1b2442246b1b2842", "hex")), null), "る");
  });
});

describe("charsetOf", () => {
  it("引用符の有無に関わらず取り出す", () => {
    assert.equal(charsetOf('text/plain; charset="ISO-2022-JP"'), "iso-2022-jp");
    assert.equal(charsetOf("text/html;charset=utf-8"), "utf-8");
    assert.equal(charsetOf("text/plain"), null);
  });
});

describe("decodeSnippet", () => {
  it("文字参照を平文へ戻す", () => {
    assert.equal(decodeSnippet("It&#39;s &lt;b&gt; &amp; &quot;x&quot;"), `It's <b> & "x"`);
  });
});

describe("displayName", () => {
  it("表示名があればそれを、無ければアドレスを返す", () => {
    assert.equal(displayName('"山田 太郎" <taro@example.com>'), "山田 太郎");
    assert.equal(displayName("<taro@example.com>"), "taro@example.com");
    assert.equal(displayName("taro@example.com"), "taro@example.com");
  });
});

describe("toSummary / toDetail", () => {
  const message = {
    id: "18c0ffee",
    threadId: "18c0ffee",
    labelIds: ["INBOX", "UNREAD", "Label_1"],
    snippet: "ご確認ください",
    internalDate: "1700000000000",
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: "店 <shop@example.com>" },
        { name: "To", value: "me@example.com" },
        { name: "Subject", value: "ご注文" },
      ],
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            {
              mimeType: "text/plain",
              headers: [{ name: "Content-Type", value: "text/plain; charset=ISO-2022-JP" }],
              body: { data: b64url(Buffer.from("1b2442246b1b2842", "hex")) },
            },
            {
              mimeType: "text/html",
              headers: [{ name: "Content-Type", value: "text/html; charset=UTF-8" }],
              body: { data: b64url("<p>本文</p>") },
            },
          ],
        },
        {
          partId: "1",
          mimeType: "application/pdf",
          filename: "receipt.pdf",
          headers: [{ name: "Content-Disposition", value: 'attachment; filename="receipt.pdf"' }],
          body: { attachmentId: "att", size: 2048 },
        },
      ],
    },
  };

  it("一覧の1行に必要な値を取り出す", () => {
    const summary = toSummary(message);
    assert.equal(summary.subject, "ご注文");
    assert.equal(summary.unread, true);
    assert.equal(summary.starred, false);
    assert.equal(summary.receivedAt, 1700000000000);
  });

  it("入れ子の本文と添付を集める", () => {
    const detail = toDetail(message);
    assert.equal(detail.text, "る");
    assert.equal(detail.html, "<p>本文</p>");
    assert.deepEqual(detail.attachments, [
      { filename: "receipt.pdf", mimeType: "application/pdf", size: 2048, attachmentId: "1", contentId: null, inline: false },
    ]);
    assert.equal(detail.to, "me@example.com");
  });

  it("Content-ID を持つ名前の無い image/* は inline の添付として載せる（#867）", () => {
    const detail = toDetail({
      id: "x",
      payload: {
        mimeType: "multipart/related",
        parts: [
          { partId: "0", mimeType: "text/html", body: { data: b64url('<img src="cid:logo@x">') } },
          {
            partId: "1",
            mimeType: "image/png",
            headers: [{ name: "Content-ID", value: "<logo@x>" }, { name: "Content-Disposition", value: "inline" }],
            body: { attachmentId: "volatile", size: 10 },
          },
          { partId: "2", mimeType: "image/gif", headers: [{ name: "X", value: "y" }], body: { size: 1 } },
        ],
      },
    });
    assert.deepEqual(detail.attachments, [
      { filename: "(名前なし)", mimeType: "image/png", size: 10, attachmentId: "1", contentId: "logo@x", inline: true },
    ]);
  });
});
