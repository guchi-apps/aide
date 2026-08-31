import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

// 本番の記録を汚さないよう、読み込み前に置き場を一時ディレクトリへ差し替える。
// パスはモジュール読み込み時に確定するため、import より前に設定する必要がある。
const dir = await mkdtemp(join(tmpdir(), "aide-zaim-web-idempotency-test-"));
process.env["AIDE_ZAIM_WEB_PAYMENT_LOG_PATH"] = join(dir, "zaim-web-payments.json");
const { abandonWebPayment, beginWebPayment, completeWebPayment, WEB_PAYMENT_LOG_PATH } =
  await import("./web-idempotency.ts");

interface WebPaymentRecord {
  requestId: string;
  state: "sending" | "done";
  at: string;
}

/**
 * この記録が壊れると**同じ明細がZaimへ二重に登録される**。
 * 打ち消しはこの経路からできない（削除を持たない）ので、状態遷移を押さえておく。
 *
 * 公式API経由（`idempotency.test.ts`）との違いは、**確定の印がZaimのIDではなく
 * `state: "done"` であること**。この画面はIDを表示しないため、IDでは持てない。
 */

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function readRecords(): Promise<WebPaymentRecord[]> {
  return JSON.parse(await readFile(WEB_PAYMENT_LOG_PATH, "utf8")) as WebPaymentRecord[];
}

describe("beginWebPayment", () => {
  it("初回は new を返し、画面を触る前に sending として記録する", async () => {
    assert.deepEqual(await beginWebPayment("first"), { status: "new" });

    // 送った後ではなく触る前に記録する。打ち切られたときに何も残らないと、再送で二重登録になる。
    const records = await readRecords();
    assert.deepEqual(
      records.map((record) => [record.requestId, record.state]),
      [["first", "sending"]],
    );
  });

  it("確定済みの再送は done を返す（画面を開かない）", async () => {
    await beginWebPayment("done-key");
    await completeWebPayment("done-key");

    const result = await beginWebPayment("done-key");
    assert.equal(result.status, "done");
  });

  it("結果が確定していない再送は unresolved（勝手にやり直さない）", async () => {
    await beginWebPayment("stuck");

    const result = await beginWebPayment("stuck");
    assert.equal(result.status, "unresolved");
    assert.ok("at" in result && result.at);
  });
});

describe("completeWebPayment", () => {
  it("記録が無くても done として書く", async () => {
    await completeWebPayment("recovered");
    const record = (await readRecords()).find((item) => item.requestId === "recovered");
    assert.equal(record?.state, "done");
  });
});

describe("abandonWebPayment", () => {
  it("記録を消して再送を許す", async () => {
    await beginWebPayment("abandoned");
    await abandonWebPayment("abandoned");

    assert.equal(
      (await readRecords()).some((record) => record.requestId === "abandoned"),
      false,
    );
    // 消えているので、同じキーでもう一度送れる。
    assert.deepEqual(await beginWebPayment("abandoned"), { status: "new" });
  });

  it("無い記録を消しても壊れない", async () => {
    await abandonWebPayment("never-existed");
  });
});

describe("同時に届いた場合", () => {
  it("同じ requestId で並行に始めても、new は1つだけ", async () => {
    // 読み込み〜書き出しのあいだに await を挟むため、直列化していないと両方 new になる。
    const [a, b] = await Promise.all([beginWebPayment("race"), beginWebPayment("race")]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, ["new", "unresolved"]);
  });
});

describe("記録に残すもの", () => {
  it("requestId・状態・時刻だけで、支出の中身は書かない", async () => {
    await beginWebPayment("shape-check");
    const record = (await readRecords()).find((item) => item.requestId === "shape-check");
    assert.deepEqual(Object.keys(record ?? {}).sort(), ["at", "requestId", "state"]);
  });
});
