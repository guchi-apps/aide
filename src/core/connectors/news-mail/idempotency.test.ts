import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

// 本番の記録を汚さないよう、読み込み前に置き場を一時ディレクトリへ差し替える。
const dir = await mkdtemp(join(tmpdir(), "aide-news-mail-idempotency-test-"));
process.env["AIDE_NEWS_MAIL_IDEMPOTENCY_LOG_PATH"] = join(dir, "news-mail-idempotency.json");
const { abandonNewsMail, beginNewsMail, completeNewsMail } = await import("./idempotency.ts");

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("beginNewsMail / completeNewsMail / abandonNewsMail", () => {
  it("初回は new。送信確定後に done へ遷移する", async () => {
    assert.deepEqual(await beginNewsMail("key-1"), { status: "new" });
    // 送る前に「結果不明」として記録されているため、確定前に同じキーで呼ぶと unresolved になる。
    const pending = await beginNewsMail("key-1");
    assert.equal(pending.status, "unresolved");

    await completeNewsMail("key-1", "msg-1");
    assert.deepEqual(await beginNewsMail("key-1"), { status: "done", messageId: "msg-1" });
  });

  it("送られなかったことが確実なら abandon で消え、再送できる", async () => {
    await beginNewsMail("key-2");
    await abandonNewsMail("key-2");
    assert.deepEqual(await beginNewsMail("key-2"), { status: "new" });
  });

  it("異なるキーは独立して扱われる", async () => {
    await completeNewsMail("key-3", "msg-3");
    assert.deepEqual(await beginNewsMail("key-4"), { status: "new" });
    assert.deepEqual(await beginNewsMail("key-3"), { status: "done", messageId: "msg-3" });
  });
});
