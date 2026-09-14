import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

// 本番の記録を汚さないよう、読み込み前に置き場を一時ディレクトリへ差し替える。
// パスはモジュール読み込み時に確定するため、import より前に設定する必要がある。
const dir = await mkdtemp(join(tmpdir(), "aide-zaim-web-genre-edit-idempotency-test-"));
process.env["AIDE_ZAIM_WEB_GENRE_EDIT_LOG_PATH"] = join(dir, "zaim-web-genre-edits.json");
const { abandonWebGenreEdit, beginWebGenreEdit, completeWebGenreEdit, WEB_GENRE_EDIT_LOG_PATH } =
  await import("./web-genre-edit-idempotency.ts");

interface WebGenreEditRecord {
  requestId: string;
  moneyId: number;
  state: "sending" | "done";
  at: string;
}

/**
 * この記録が壊れると**同じ明細への変更がZaimへ二重に送られる**。
 * 打ち消しはこの経路からできない（削除を持たない）ので、状態遷移を押さえておく。
 *
 * `web-idempotency.test.ts`（新規登録）との違いは、**`moneyId` を記録に持てること**。
 * 呼び出し元が渡した値をそのまま持てるため、確定済みの再送でも画面を開かず返せる。
 */

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function readRecords(): Promise<WebGenreEditRecord[]> {
  return JSON.parse(await readFile(WEB_GENRE_EDIT_LOG_PATH, "utf8")) as WebGenreEditRecord[];
}

describe("beginWebGenreEdit", () => {
  it("初回は new を返し、画面を触る前に sending として moneyId ごと記録する", async () => {
    assert.deepEqual(await beginWebGenreEdit("first", 111), { status: "new" });

    const records = await readRecords();
    assert.deepEqual(
      records.map((record) => [record.requestId, record.moneyId, record.state]),
      [["first", 111, "sending"]],
    );
  });

  it("確定済みの再送は done と moneyId を返す（画面を開かない）", async () => {
    await beginWebGenreEdit("done-key", 222);
    await completeWebGenreEdit("done-key", 222);

    const result = await beginWebGenreEdit("done-key", 222);
    assert.deepEqual(result, { status: "done", moneyId: 222, at: result.status === "done" ? result.at : "" });
  });

  it("結果が確定していない再送は unresolved（勝手にやり直さない）", async () => {
    await beginWebGenreEdit("stuck", 333);

    const result = await beginWebGenreEdit("stuck", 333);
    assert.equal(result.status, "unresolved");
    assert.ok("at" in result && result.at);
  });
});

describe("completeWebGenreEdit", () => {
  it("記録が無くても moneyId 付きで done として書く", async () => {
    await completeWebGenreEdit("recovered", 444);
    const record = (await readRecords()).find((item) => item.requestId === "recovered");
    assert.equal(record?.state, "done");
    assert.equal(record?.moneyId, 444);
  });
});

describe("abandonWebGenreEdit", () => {
  it("記録を消して再送を許す", async () => {
    await beginWebGenreEdit("abandoned", 555);
    await abandonWebGenreEdit("abandoned");

    assert.equal(
      (await readRecords()).some((record) => record.requestId === "abandoned"),
      false,
    );
    assert.deepEqual(await beginWebGenreEdit("abandoned", 555), { status: "new" });
  });

  it("無い記録を消しても壊れない", async () => {
    await abandonWebGenreEdit("never-existed");
  });
});

describe("記録に残すもの", () => {
  it("requestId・moneyId・状態・時刻だけで、変更後のカテゴリ等は書かない", async () => {
    await beginWebGenreEdit("shape-check", 666);
    const record = (await readRecords()).find((item) => item.requestId === "shape-check");
    assert.deepEqual(Object.keys(record ?? {}).sort(), ["at", "moneyId", "requestId", "state"]);
  });
});
