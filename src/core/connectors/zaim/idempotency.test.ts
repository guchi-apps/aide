import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

// 本番の記録を汚さないよう、読み込み前に置き場を一時ディレクトリへ差し替える。
// パスはモジュール読み込み時に確定するため、import より前に設定する必要がある。
const dir = await mkdtemp(join(tmpdir(), "aide-zaim-idempotency-test-"));
process.env["AIDE_ZAIM_PAYMENT_LOG_PATH"] = join(dir, "zaim-payments.json");
const { abandonPayment, beginPayment, completePayment, PAYMENT_LOG_PATH } = await import("./idempotency.ts");

interface PaymentRecord {
  requestId: string;
  moneyId: number | null;
  at: string;
}

/**
 * この記録が壊れると**同じ支出がZaimへ二重に登録される**。
 * 打ち消しはAPIからできない（このコネクタは削除を持たない）ので、状態遷移を押さえておく。
 */

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function readRecords(): Promise<PaymentRecord[]> {
  return JSON.parse(await readFile(PAYMENT_LOG_PATH, "utf8")) as PaymentRecord[];
}

describe("beginPayment", () => {
  it("初回は new を返し、送る前に「結果不明」として記録する", async () => {
    assert.deepEqual(await beginPayment("first"), { status: "new" });

    // 送った後ではなく送る前に記録する。打ち切られたときに何も残らないと、再送で二重登録になる。
    const records = await readRecords();
    assert.deepEqual(
      records.map((record) => [record.requestId, record.moneyId]),
      [["first", null]],
    );
  });

  it("確定前にもう一度来たら unresolved で止める", async () => {
    await beginPayment("pending");
    const again = await beginPayment("pending");
    assert.equal(again.status, "unresolved");
  });

  it("確定済みなら done と money_id を返す（Zaimへは送らせない）", async () => {
    await beginPayment("done-1");
    await completePayment("done-1", 123456);
    assert.deepEqual(await beginPayment("done-1"), { status: "done", moneyId: 123456 });
  });
});

describe("abandonPayment", () => {
  it("消した後は new に戻る", async () => {
    await beginPayment("rejected-1");
    await abandonPayment("rejected-1");
    assert.deepEqual(await beginPayment("rejected-1"), { status: "new" });
  });
});

describe("記録の中身", () => {
  it("requestId・moneyId・時刻の3つだけを持つ（金額や店名は書かない）", async () => {
    await beginPayment("fields");
    await completePayment("fields", 999);
    const record = (await readRecords()).find((row) => row.requestId === "fields");
    assert.ok(record);
    assert.deepEqual(Object.keys(record as object).sort(), ["at", "moneyId", "requestId"]);
  });

  it("500件を超えたら古い順に捨てる", async () => {
    const overflowing: PaymentRecord[] = Array.from({ length: 520 }, (_, index) => ({
      requestId: `old-${index}`,
      moneyId: index,
      at: "2026-08-01T00:00:00.000Z",
    }));
    await writeFile(PAYMENT_LOG_PATH, JSON.stringify(overflowing), "utf8");

    await beginPayment("newest");
    const records = await readRecords();
    assert.equal(records.length, 500);
    assert.equal(records.at(-1)?.requestId, "newest");
    // 捨てられるのは古い方から。
    assert.equal(records[0]?.requestId, "old-21");
  });

  it("壊れていても登録そのものは止めない", async () => {
    await writeFile(PAYMENT_LOG_PATH, "{壊れたJSON", "utf8");
    assert.deepEqual(await beginPayment("after-broken"), { status: "new" });
  });
});

describe("同時に届いた場合", () => {
  it("直列化されるので、片方の記録が消えない", async () => {
    await writeFile(PAYMENT_LOG_PATH, "[]", "utf8");
    await Promise.all([beginPayment("parallel-a"), beginPayment("parallel-b")]);
    const ids = (await readRecords()).map((record) => record.requestId).sort();
    assert.deepEqual(ids, ["parallel-a", "parallel-b"]);
  });
});
