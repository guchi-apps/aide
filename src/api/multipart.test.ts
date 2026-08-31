import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractBoundary, parseMultipart } from "./multipart.ts";

const BOUNDARY = "AideTestBoundary123";

function buildMultipartBody(parts: { name: string; filename?: string; contentType?: string; data: Buffer }[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${BOUNDARY}\r\n`));
    const disposition = part.filename
      ? `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`
      : `Content-Disposition: form-data; name="${part.name}"\r\n`;
    chunks.push(Buffer.from(disposition));
    if (part.contentType) chunks.push(Buffer.from(`Content-Type: ${part.contentType}\r\n`));
    chunks.push(Buffer.from("\r\n"));
    chunks.push(part.data);
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}

describe("extractBoundary", () => {
  it("multipart/form-data のboundaryを取り出す", () => {
    assert.equal(extractBoundary(`multipart/form-data; boundary=${BOUNDARY}`), BOUNDARY);
  });

  it("引用符付きのboundaryも取り出す", () => {
    assert.equal(extractBoundary(`multipart/form-data; boundary="${BOUNDARY}"`), BOUNDARY);
  });

  it("multipart/form-data 以外は null", () => {
    assert.equal(extractBoundary(`application/json`), null);
  });

  it("boundaryが無ければ null", () => {
    assert.equal(extractBoundary(`multipart/form-data`), null);
  });

  it("未指定なら null", () => {
    assert.equal(extractBoundary(undefined), null);
  });
});

describe("parseMultipart", () => {
  it("テキストフィールドとファイルパートを分解する", () => {
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02]);
    const body = buildMultipartBody([
      { name: "title", data: Buffer.from("テスト画像", "utf8") },
      { name: "width", data: Buffer.from("1200") },
      {
        name: "zip",
        filename: "images.zip",
        contentType: "application/zip",
        data: zip,
      },
    ]);

    const parsed = parseMultipart(body, BOUNDARY);
    assert.ok(!("error" in parsed));
    assert.equal(parsed.fields["title"], "テスト画像");
    assert.equal(parsed.fields["width"], "1200");
    assert.ok(parsed.file);
    assert.equal(parsed.file.filename, "images.zip");
    assert.equal(parsed.file.contentType, "application/zip");
    assert.ok(parsed.file.data.equals(zip));
  });

  it("ZIPバイト列にboundaryに近い並びが混ざっていても壊れない", () => {
    // 改行やハイフンの並びをわざと混入させ、境界検出がバイナリの中身に引きずられないことを確かめる。
    const zip = Buffer.concat([
      Buffer.from("\r\n\r\n--fake--\r\n", "latin1"),
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00, 0x01]),
    ]);
    const body = buildMultipartBody([
      { name: "title", data: Buffer.from("test") },
      { name: "zip", filename: "images.zip", contentType: "application/zip", data: zip },
    ]);

    const parsed = parseMultipart(body, BOUNDARY);
    assert.ok(!("error" in parsed));
    assert.ok(parsed.file);
    assert.ok(parsed.file.data.equals(zip));
  });

  it("ファイルパートが無ければ file は null", () => {
    const body = buildMultipartBody([{ name: "title", data: Buffer.from("test") }]);
    const parsed = parseMultipart(body, BOUNDARY);
    assert.ok(!("error" in parsed));
    assert.equal(parsed.file, null);
  });

  it("ファイルパートが2件以上ならエラー", () => {
    const body = buildMultipartBody([
      { name: "zip", filename: "a.zip", contentType: "application/zip", data: Buffer.from("a") },
      { name: "zip2", filename: "b.zip", contentType: "application/zip", data: Buffer.from("b") },
    ]);
    const parsed = parseMultipart(body, BOUNDARY);
    assert.ok("error" in parsed);
  });

  it("boundaryが見つからなければエラー", () => {
    const parsed = parseMultipart(Buffer.from("not multipart"), BOUNDARY);
    assert.ok("error" in parsed);
  });
});
