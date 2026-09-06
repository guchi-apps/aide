import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeCreateEventInput, readDaySpanWriteConfig } from "./write.ts";

describe("normalizeCreateEventInput", () => {
  it("title・dateだけの最小構成を受け付ける（終日の予定になる）", () => {
    const result = normalizeCreateEventInput({ title: "出張", date: "2026-09-10" });
    assert.deepEqual(result, { input: { title: "出張", date: "2026-09-10" } });
  });

  it("title が空なら弾く", () => {
    const result = normalizeCreateEventInput({ title: "  ", date: "2026-09-10" });
    assert.ok("error" in result);
  });

  it("date が実在しない日付なら弾く", () => {
    const result = normalizeCreateEventInput({ title: "歯医者", date: "2026-02-30" });
    assert.ok("error" in result);
  });

  it("date が YYYY-MM-DD 形式でなければ弾く", () => {
    const result = normalizeCreateEventInput({ title: "歯医者", date: "2026/09/10" });
    assert.ok("error" in result);
  });

  it("startTime・endTime を両方指定すれば通る", () => {
    const result = normalizeCreateEventInput({
      title: "歯医者",
      date: "2026-09-10",
      startTime: "10:00",
      endTime: "11:00",
    });
    assert.deepEqual(result, {
      input: { title: "歯医者", date: "2026-09-10", startTime: "10:00", endTime: "11:00" },
    });
  });

  it("startTime だけの片方指定は弾く（終日か時刻ありか決まらない）", () => {
    const result = normalizeCreateEventInput({ title: "歯医者", date: "2026-09-10", startTime: "10:00" });
    assert.ok("error" in result);
  });

  it("endTime だけの片方指定は弾く", () => {
    const result = normalizeCreateEventInput({ title: "歯医者", date: "2026-09-10", endTime: "11:00" });
    assert.ok("error" in result);
  });

  it("HH:MM 形式でない時刻は弾く", () => {
    const result = normalizeCreateEventInput({
      title: "歯医者",
      date: "2026-09-10",
      startTime: "10時",
      endTime: "11:00",
    });
    assert.ok("error" in result);
  });

  it("endTime が startTime より前・同時刻なら弾く", () => {
    for (const endTime of ["09:00", "10:00"]) {
      const result = normalizeCreateEventInput({
        title: "歯医者",
        date: "2026-09-10",
        startTime: "10:00",
        endTime,
      });
      assert.ok("error" in result, `endTime=${endTime}`);
    }
  });

  it("location・calendarId を渡せば含める。空文字は指定なしとして落とす", () => {
    const result = normalizeCreateEventInput({
      title: "歯医者",
      date: "2026-09-10",
      location: "  渋谷歯科  ",
      calendarId: "",
    });
    assert.deepEqual(result, { input: { title: "歯医者", date: "2026-09-10", location: "渋谷歯科" } });
  });
});

describe("readDaySpanWriteConfig", () => {
  it("AIDE_DAYSPAN_WRITE_TOKEN が無ければ null（＝叩きに行かない）", () => {
    const original = process.env["AIDE_DAYSPAN_WRITE_TOKEN"];
    delete process.env["AIDE_DAYSPAN_WRITE_TOKEN"];
    try {
      assert.equal(readDaySpanWriteConfig(), null);
    } finally {
      if (original !== undefined) process.env["AIDE_DAYSPAN_WRITE_TOKEN"] = original;
    }
  });

  it("トークンがあれば既定のURLを補う", () => {
    const originalToken = process.env["AIDE_DAYSPAN_WRITE_TOKEN"];
    const originalUrl = process.env["AIDE_DAYSPAN_URL"];
    process.env["AIDE_DAYSPAN_WRITE_TOKEN"] = "secret";
    delete process.env["AIDE_DAYSPAN_URL"];
    try {
      assert.deepEqual(readDaySpanWriteConfig(), { baseUrl: "http://127.0.0.1:3113", token: "secret" });
    } finally {
      if (originalToken === undefined) delete process.env["AIDE_DAYSPAN_WRITE_TOKEN"];
      else process.env["AIDE_DAYSPAN_WRITE_TOKEN"] = originalToken;
      if (originalUrl !== undefined) process.env["AIDE_DAYSPAN_URL"] = originalUrl;
    }
  });
});
