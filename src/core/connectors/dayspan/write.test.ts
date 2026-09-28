import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { resetSharedTokenCacheForTest } from "../issue-deck/shared-tokens.ts";
import {
  normalizeCreateEventInput,
  normalizeDeleteEventInput,
  normalizeUpdateEventInput,
  readDaySpanWriteConfig,
} from "./write.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetSharedTokenCacheForTest();
});

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
  it("AIDE_DAYSPAN_WRITE_TOKEN が無ければ null（＝叩きに行かない）", async () => {
    const original = process.env["AIDE_DAYSPAN_WRITE_TOKEN"];
    delete process.env["AIDE_DAYSPAN_WRITE_TOKEN"];
    try {
      assert.equal(await readDaySpanWriteConfig(), null);
    } finally {
      if (original !== undefined) process.env["AIDE_DAYSPAN_WRITE_TOKEN"] = original;
    }
  });

  it("トークンがあれば既定のURLを補う", async () => {
    const originalToken = process.env["AIDE_DAYSPAN_WRITE_TOKEN"];
    const originalUrl = process.env["AIDE_DAYSPAN_URL"];
    process.env["AIDE_DAYSPAN_WRITE_TOKEN"] = "secret";
    delete process.env["AIDE_DAYSPAN_URL"];
    try {
      assert.deepEqual(await readDaySpanWriteConfig(), { baseUrl: "http://127.0.0.1:3113", token: "secret" });
    } finally {
      if (originalToken === undefined) delete process.env["AIDE_DAYSPAN_WRITE_TOKEN"];
      else process.env["AIDE_DAYSPAN_WRITE_TOKEN"] = originalToken;
      if (originalUrl !== undefined) process.env["AIDE_DAYSPAN_URL"] = originalUrl;
    }
  });

  it("共有トークンAPIから取得できればそちらを優先する", async () => {
    const originalToken = process.env["AIDE_DAYSPAN_WRITE_TOKEN"];
    const originalDeckUrl = process.env["AIDE_ISSUE_DECK_URL"];
    const originalSecret = process.env["SHARED_TOKEN_API_SECRET"];
    process.env["AIDE_DAYSPAN_WRITE_TOKEN"] = "env-token";
    process.env["AIDE_ISSUE_DECK_URL"] = "https://deck.example.test";
    process.env["SHARED_TOKEN_API_SECRET"] = "shared-token-api-secret";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ name: "DAYSPAN_INTERNAL_EVENTS_API_KEY", value: "shared-token" }), { status: 200 })) as typeof fetch;
    try {
      assert.deepEqual(await readDaySpanWriteConfig(), { baseUrl: "http://127.0.0.1:3113", token: "shared-token" });
    } finally {
      if (originalToken === undefined) delete process.env["AIDE_DAYSPAN_WRITE_TOKEN"];
      else process.env["AIDE_DAYSPAN_WRITE_TOKEN"] = originalToken;
      if (originalDeckUrl === undefined) delete process.env["AIDE_ISSUE_DECK_URL"];
      else process.env["AIDE_ISSUE_DECK_URL"] = originalDeckUrl;
      if (originalSecret === undefined) delete process.env["SHARED_TOKEN_API_SECRET"];
      else process.env["SHARED_TOKEN_API_SECRET"] = originalSecret;
    }
  });
});

describe("normalizeUpdateEventInput", () => {
  const target = { eventId: "abc123", calendarId: "primary" };

  it("送った項目だけを入力へ含める", () => {
    const result = normalizeUpdateEventInput({ ...target, startTime: "14:00", endTime: "15:00" });
    assert.deepEqual(result, { input: { ...target, startTime: "14:00", endTime: "15:00" } });
  });

  it("終了日を指定すれば、翌日以降へまたがる時刻予定を受け付ける", () => {
    assert.deepEqual(
      normalizeUpdateEventInput({
        ...target,
        date: "2026-09-10",
        endDate: "2026-09-11",
        startTime: "23:00",
        endTime: "01:00",
      }),
      {
        input: {
          ...target,
          date: "2026-09-10",
          endDate: "2026-09-11",
          startTime: "23:00",
          endTime: "01:00",
        },
      },
    );
  });

  it("eventId・calendarId が無ければ弾く", () => {
    assert.ok("error" in normalizeUpdateEventInput({ calendarId: "primary", title: "x" }));
    assert.ok("error" in normalizeUpdateEventInput({ eventId: "abc123", title: "x" }));
  });

  it("変える項目が1つも無ければ弾く", () => {
    assert.ok("error" in normalizeUpdateEventInput(target));
  });

  it("location は空文字で消せる", () => {
    assert.deepEqual(normalizeUpdateEventInput({ ...target, location: "" }), {
      input: { ...target, location: "" },
    });
  });

  it("時刻が片方だけ・逆転・allDay との同時指定は弾く", () => {
    assert.ok("error" in normalizeUpdateEventInput({ ...target, startTime: "10:00" }));
    assert.ok("error" in normalizeUpdateEventInput({ ...target, startTime: "10:00", endTime: "09:00" }));
    assert.ok(
      "error" in normalizeUpdateEventInput({ ...target, allDay: true, startTime: "10:00", endTime: "11:00" }),
    );
    assert.ok(
      "error" in normalizeUpdateEventInput({ ...target, allDay: true, endDate: "2026-09-11" }),
    );
  });

  it("同日の逆転時刻・開始日より前または不正な終了日は弾く", () => {
    assert.ok(
      "error" in
        normalizeUpdateEventInput({
          ...target,
          date: "2026-09-10",
          endDate: "2026-09-10",
          startTime: "10:00",
          endTime: "09:00",
        }),
    );
    assert.ok(
      "error" in normalizeUpdateEventInput({ ...target, date: "2026-09-10", endDate: "2026-09-09" }),
    );
    assert.ok("error" in normalizeUpdateEventInput({ ...target, endDate: "2026-02-30" }));
    assert.ok("error" in normalizeUpdateEventInput({ ...target, endDate: "2026-09-11" }));
  });

  it("実在しない日付・空のタイトルは弾く", () => {
    assert.ok("error" in normalizeUpdateEventInput({ ...target, date: "2026-02-30" }));
    assert.ok("error" in normalizeUpdateEventInput({ ...target, title: "  " }));
  });
});

describe("normalizeDeleteEventInput", () => {
  it("eventId・calendarId・title を要る。title は前後の空白を落とす", () => {
    assert.deepEqual(
      normalizeDeleteEventInput({ eventId: "abc123", calendarId: "primary", title: " 歯医者 " }),
      { input: { eventId: "abc123", calendarId: "primary", title: "歯医者" } },
    );
  });

  it("title が無ければ弾く（取り違えの防止をDaySpanへ任せきりにしない）", () => {
    assert.ok("error" in normalizeDeleteEventInput({ eventId: "abc123", calendarId: "primary" }));
  });
});
