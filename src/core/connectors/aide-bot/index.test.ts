import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAideBotNotice, normalizeNoticeInput, readAideBotConfig } from "./index.ts";

const validArgs = {
  title: "歯科の予約",
  summary: "明日13時から予約があります。",
  source: "calendar",
  dedupeKey: "calendar:event-1",
  priority: "URGENT",
  url: "https://calendar.example.test/event-1",
  recommendedAction: "出発前に確認する",
  showAt: "2026-08-30T09:00:00+09:00",
  expiresAt: "2026-08-30T13:00:00+09:00",
};

describe("aide-bot notice connector", () => {
  it("設定値が揃わなければ未設定として扱う", () => {
    assert.equal(readAideBotConfig({}), null);
    assert.equal(readAideBotConfig({ AIDE_BOT_URL: "ftp://bot.test", AIDE_BOT_TOKEN: "secret", AIDE_BOT_EMAIL: "a@example.test" }), null);
  });

  it("入力を正規化し、メールアドレスを含めない", () => {
    const result = normalizeNoticeInput(validArgs, "task");
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.input.kind, "task");
      assert.equal(result.input.showAt, "2026-08-30T00:00:00.000Z");
    }
  });

  it("必須値・優先度・日時を検証する", () => {
    assert.equal(normalizeNoticeInput({ ...validArgs, title: " " }, "schedule").ok, false);
    assert.equal(normalizeNoticeInput({ ...validArgs, priority: "HIGH" }, "schedule").ok, false);
    assert.equal(normalizeNoticeInput({ ...validArgs, expiresAt: "明日" }, "schedule").ok, false);
  });

  it("Bearer認証付きでaide-botへ登録し、入力された種別を送る", async () => {
    const config = { url: "https://bot.example.test", token: "server-secret", email: "user@example.test" };
    let request = null as { url: string; init: RequestInit } | null;
    const outcome = await createAideBotNotice(
      {
        kind: "daily-brief",
        title: validArgs.title,
        summary: validArgs.summary,
        source: validArgs.source,
        dedupeKey: validArgs.dedupeKey,
        priority: "NORMAL",
        url: null,
        recommendedAction: "",
        showAt: null,
        expiresAt: null,
      },
      config,
      async (url, init) => {
        request = { url: String(url), init: init! };
        return new Response(JSON.stringify({ id: "notice-1" }), { status: 201 });
      },
    );

    assert.deepEqual(outcome, { ok: true, accepted: true, id: "notice-1", kind: "daily-brief" });
    assert.ok(request);
    const captured = request;
    assert.equal(captured.url, "https://bot.example.test/api/notices");
    assert.equal((captured.init.headers as Record<string, string>).Authorization, "Bearer server-secret");
    const body = JSON.parse(String(captured.init.body));
    assert.equal(body.email, "user@example.test");
    assert.equal(body.kind, "daily-brief");
    assert.equal(body.title, validArgs.title);
    assert.equal(body.body, validArgs.summary);
  });

  it("未設定時とHTTPエラー時は外部へ秘密情報を返さない", async () => {
    const input = {
      kind: "schedule" as const,
      title: validArgs.title,
      summary: validArgs.summary,
      source: validArgs.source,
      dedupeKey: validArgs.dedupeKey,
      priority: "NORMAL" as const,
      url: null,
      recommendedAction: "",
      showAt: null,
      expiresAt: null,
    };
    const notConfigured = await createAideBotNotice(input, null, async () => { throw new Error("must not call"); });
    assert.equal(notConfigured.ok, false);
    if (!notConfigured.ok) assert.match(notConfigured.reason, /未設定/);
    const failed = await createAideBotNotice(input, { url: "https://bot.example.test", token: "secret", email: "user@example.test" }, async () => new Response("", { status: 401 }));
    assert.deepEqual(failed, { ok: false, reason: "aide-botへの登録に失敗しました（HTTP 401）" });
  });
});
