import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

// 本番の記録を汚さないよう、読み込み前に置き場を一時ディレクトリへ差し替える。
const dir = await mkdtemp(join(tmpdir(), "aide-text-mail-idempotency-test-"));
process.env["AIDE_TEXT_MAIL_IDEMPOTENCY_LOG_PATH"] = join(dir, "text-mail-idempotency.json");
const { abandonTextMail, beginTextMail, completeTextMail } = await import("./idempotency.ts");

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("beginTextMail / completeTextMail / abandonTextMail", () => {
  it("初回は new。送信確定後に done へ遷移する", async () => {
    assert.deepEqual(await beginTextMail("key-1"), { status: "new" });
    // 送る前に「結果不明」として記録されているため、確定前に同じキーで呼ぶと unresolved になる。
    const pending = await beginTextMail("key-1");
    assert.equal(pending.status, "unresolved");

    await completeTextMail("key-1", "msg-1");
    assert.deepEqual(await beginTextMail("key-1"), { status: "done", messageId: "msg-1" });
  });

  it("送られなかったことが確実なら abandon で消え、再送できる", async () => {
    await beginTextMail("key-2");
    await abandonTextMail("key-2");
    assert.deepEqual(await beginTextMail("key-2"), { status: "new" });
  });

  it("異なるキーは独立して扱われる", async () => {
    await completeTextMail("key-3", "msg-3");
    assert.deepEqual(await beginTextMail("key-4"), { status: "new" });
    assert.deepEqual(await beginTextMail("key-3"), { status: "done", messageId: "msg-3" });
  });
});
