import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, describe, it } from "node:test";
import { ZAIM_SESSION_EXPIRED } from "./errors.ts";
import type { ZaimScriptDeps, ZaimScriptOptions } from "./session.ts";

// 冪等記録は本番の置き場を避ける。パスはモジュール読み込み時に確定するため、import より前に。
// メモの書き換えはカテゴリの変更と同じ記録ファイルを使う（`web-memo-edit.ts` 冒頭のコメント参照）。
const dir = await mkdtemp(join(tmpdir(), "aide-zaim-web-memo-edit-test-"));
process.env["AIDE_ZAIM_WEB_GENRE_EDIT_LOG_PATH"] = join(dir, "zaim-web-genre-edits.json");
const { createZaimWebMemoEdit, normalizeWebMemoEditInput } = await import("./web-memo-edit.ts");

/**
 * 既存明細のメモの書き換え（#354）。
 *
 * Playwrightを起動する本体は `scripts/edit-memo.mjs` にある。ここで見るのは**入力の検査**と、
 * **失敗したときにZaimに何が残っているかの判断**——つまり二重実行を防ぐ側の分岐
 * （`web-genre-edit.test.ts` と同じ流儀）。失敗の分類そのものは `web-genre-edit.test.ts` が押さえている。
 */

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const VALID = {
  requestId: "asset-manager:zaim-memo:5001:abc123",
  moneyId: 5001,
  amount: 1284,
  date: "2026-09-17",
  comment: "おにぎり 158円／牛乳 218円",
};

const SCRIPT_OK = JSON.stringify({
  submitted: true,
  url: "https://zaim.net/money/5001/edit",
  resultUrl: "https://zaim.net/money",
  filled: { comment: VALID.comment, amount: 1284, date: "2026年9月17日(木)" },
});

/** `deps.exec` を差し替え、渡された環境変数とオプションを覗けるようにする。 */
function stubDeps(results: (string | Error)[]): ZaimScriptDeps & {
  calls: string[];
  options: ZaimScriptOptions[];
} {
  const calls: string[] = [];
  const options: ZaimScriptOptions[] = [];
  return {
    calls,
    options,
    async exec(script, given) {
      calls.push(basename(script));
      options.push(given);
      const result = results.shift();
      if (result === undefined) throw new Error("想定より多く呼ばれました");
      if (result instanceof Error) throw result;
      return { stdout: result };
    },
    async sleep() {},
    now() {
      return 0;
    },
  };
}

async function readRecords(): Promise<{ requestId: string; moneyId: number; state: string }[]> {
  try {
    return JSON.parse(
      await readFile(process.env["AIDE_ZAIM_WEB_GENRE_EDIT_LOG_PATH"]!, "utf8"),
    ) as { requestId: string; moneyId: number; state: string }[];
  } catch {
    return [];
  }
}

describe("normalizeWebMemoEditInput", () => {
  it("そろっていれば通す", () => {
    const result = normalizeWebMemoEditInput(VALID);
    assert.ok("input" in result);
    assert.deepEqual(result.input, VALID);
  });

  it("requestId・moneyId・date・amount・comment は必須", () => {
    for (const key of ["requestId", "moneyId", "date", "amount", "comment"] as const) {
      const body: Record<string, unknown> = { ...VALID };
      delete body[key];
      assert.ok("error" in normalizeWebMemoEditInput(body), `${key} が無くても通ってしまいます`);
    }
  });

  it("空文字の comment はメモを消す指定として通す", () => {
    for (const comment of ["", "   "]) {
      const result = normalizeWebMemoEditInput({ ...VALID, comment });
      assert.ok("input" in result, JSON.stringify(comment));
      assert.equal(result.input.comment, "");
    }
  });

  it("comment が null・文字列以外なら弾く（メモが黙って消えないように）", () => {
    for (const comment of [null, undefined, 123, ["a"], {}]) {
      assert.ok("error" in normalizeWebMemoEditInput({ ...VALID, comment }), JSON.stringify(comment));
    }
  });

  it("前後の空白は落とす", () => {
    const result = normalizeWebMemoEditInput({ ...VALID, comment: "  牛乳  " });
    assert.ok("input" in result);
    assert.equal(result.input.comment, "牛乳");
  });

  it("上限（100文字）ちょうどは通し、超えたら切らずに弾く", () => {
    const atLimit = normalizeWebMemoEditInput({ ...VALID, comment: "あ".repeat(100) });
    assert.ok("input" in atLimit);
    assert.equal(atLimit.input.comment.length, 100);

    const over = normalizeWebMemoEditInput({ ...VALID, comment: "あ".repeat(101) });
    assert.ok("error" in over);
    assert.match(over.error, /100文字/);
  });

  it("改行・タブ・制御文字を含むメモは弾く（メモ欄は1行の入力）", () => {
    for (const comment of ["a\nb", "a\tb", "a\u0000b"]) {
      assert.ok("error" in normalizeWebMemoEditInput({ ...VALID, comment }), JSON.stringify(comment));
    }
  });

  it("moneyId・date・amount・requestId の検査はカテゴリの変更と同じ", () => {
    assert.ok("error" in normalizeWebMemoEditInput({ ...VALID, moneyId: 0 }));
    assert.ok("error" in normalizeWebMemoEditInput({ ...VALID, moneyId: "5001" }));
    assert.ok("error" in normalizeWebMemoEditInput({ ...VALID, date: "2026-02-31" }));
    assert.ok("error" in normalizeWebMemoEditInput({ ...VALID, amount: 0 }));
    assert.ok("error" in normalizeWebMemoEditInput({ ...VALID, amount: 1.5 }));
    assert.ok("error" in normalizeWebMemoEditInput({ ...VALID, requestId: "a\nb" }));
  });

  it("categoryName・genreName など、メモ以外の項目は受け取らない", () => {
    const result = normalizeWebMemoEditInput({
      ...VALID,
      categoryName: "食費",
      genreName: "調理食品",
      name: "x",
    });
    assert.ok("input" in result);
    for (const key of ["categoryName", "genreName", "name", "place", "fromAccountId"]) {
      assert.ok(!(key in result.input), `${key} を通してしまいます`);
    }
  });

  it("JSONオブジェクト以外を弾く", () => {
    assert.ok("error" in normalizeWebMemoEditInput(null));
    assert.ok("error" in normalizeWebMemoEditInput([VALID]));
    assert.ok("error" in normalizeWebMemoEditInput("x"));
  });

  it("dryRun は true のときだけ立てる", () => {
    const on = normalizeWebMemoEditInput({ ...VALID, dryRun: true });
    assert.ok("input" in on);
    assert.equal(on.input.dryRun, true);

    const off = normalizeWebMemoEditInput({ ...VALID, dryRun: "true" });
    assert.ok("input" in off);
    assert.ok(!("dryRun" in off.input));
  });
});

describe("createZaimWebMemoEdit", () => {
  it("書き換えできたら記録を確定し、渡した moneyId をそのまま返す", async () => {
    const deps = stubDeps([SCRIPT_OK]);
    const outcome = await createZaimWebMemoEdit({ ...VALID, requestId: "ok-1" }, deps);

    assert.deepEqual(deps.calls, ["edit-memo.mjs"]);
    assert.ok(outcome.ok);
    assert.equal(outcome.moneyId, VALID.moneyId);
    assert.equal(outcome.duplicated, false);

    const record = (await readRecords()).find((item) => item.requestId === "ok-1");
    assert.equal(record?.state, "done");
    assert.equal(record?.moneyId, VALID.moneyId);
  });

  it("メモの本文は環境変数で渡す（`ps` に出さない）。requestId は本文に混ぜない", async () => {
    const deps = stubDeps([SCRIPT_OK]);
    await createZaimWebMemoEdit({ ...VALID, requestId: "env-1" }, deps);

    const passed = deps.options[0]?.env?.["ZAIM_WEB_MEMO_EDIT_INPUT"];
    assert.ok(passed);
    const parsed = JSON.parse(passed) as { requestId: string; comment: string };
    assert.equal(parsed.requestId, "env-1");
    assert.equal(parsed.comment, VALID.comment, "メモの本文をそのまま渡す");
    assert.ok(!parsed.comment.includes("env-1"));
  });

  it("一時的な失敗をやり直さない（やり直すと同じ明細へ二重に書き込まれる）", async () => {
    const deps = stubDeps([new Error("page.goto: net::ERR_ADDRESS_UNREACHABLE"), SCRIPT_OK]);
    const outcome = await createZaimWebMemoEdit({ ...VALID, requestId: "no-retry" }, deps);

    assert.equal(deps.calls.length, 1, "やり直してはいけない");
    assert.equal(outcome.ok, false);
    assert.equal(deps.options[0]?.retryTransient, false);

    const record = (await readRecords()).find((item) => item.requestId === "no-retry");
    assert.equal(record?.state, "sending");
  });

  it("同じ requestId の再送は画面を開かず duplicated と moneyId を返す", async () => {
    await createZaimWebMemoEdit({ ...VALID, requestId: "dup-1" }, stubDeps([SCRIPT_OK]));

    const second = stubDeps([]);
    const outcome = await createZaimWebMemoEdit({ ...VALID, requestId: "dup-1" }, second);
    assert.deepEqual(second.calls, [], "書き換え済みならZaimを開かない");
    assert.ok(outcome.ok);
    assert.equal(outcome.duplicated, true);
    assert.equal(outcome.moneyId, VALID.moneyId);
  });

  it("本文が変われば requestId も変わるので、同じ明細のメモをもう一度書き換えられる", async () => {
    await createZaimWebMemoEdit({ ...VALID, requestId: "asset-manager:zaim-memo:5001:v1" }, stubDeps([SCRIPT_OK]));

    const next = stubDeps([SCRIPT_OK]);
    const outcome = await createZaimWebMemoEdit(
      { ...VALID, requestId: "asset-manager:zaim-memo:5001:v2", comment: "牛乳 218円" },
      next,
    );
    assert.deepEqual(next.calls, ["edit-memo.mjs"]);
    assert.ok(outcome.ok && outcome.duplicated === false);
  });

  it("結果が確定していない再送は、塞がずに画面を開いて送り直せる（べき等なため）", async () => {
    const failing = stubDeps([new Error("ZAIM_RECEIPT_SUBMITTED:確認できませんでした")]);
    const first = await createZaimWebMemoEdit({ ...VALID, requestId: "retry-1" }, failing);
    assert.ok(!first.ok && first.kind === "failed");

    const retry = stubDeps([SCRIPT_OK]);
    const outcome = await createZaimWebMemoEdit({ ...VALID, requestId: "retry-1" }, retry);
    assert.deepEqual(retry.calls, ["edit-memo.mjs"]);
    assert.ok(outcome.ok);
    assert.equal(outcome.duplicated, false);

    const record = (await readRecords()).find((item) => item.requestId === "retry-1");
    assert.equal(record?.state, "done");
  });

  it("開いた明細が一致しない（取り違え）は送信前の失敗として記録を消す", async () => {
    const failing = stubDeps([
      new Error("ZAIM_RECEIPT_FORM:開いた明細の金額が一致しません（期待 1284、実際 500）"),
    ]);
    const outcome = await createZaimWebMemoEdit({ ...VALID, requestId: "mismatch-1" }, failing);
    assert.ok(!outcome.ok && outcome.kind === "rejected");
    assert.match(outcome.ok === false ? outcome.reason : "", /一致しません/);

    assert.equal(
      (await readRecords()).some((record) => record.requestId === "mismatch-1"),
      false,
      "Zaimには何も変更されていないので、記録を残して再送を塞いではいけない",
    );
  });

  it("失敗の理由にメモの本文を載せない", async () => {
    const secretComment = "秘密のメモ本文";
    const failing = stubDeps([new Error("ZAIM_RECEIPT_FORM:メモの入力欄 が 0 個見つかりました")]);
    const outcome = await createZaimWebMemoEdit(
      { ...VALID, requestId: "no-leak", comment: secretComment },
      failing,
    );
    assert.ok(!outcome.ok);
    assert.ok(!outcome.reason.includes(secretComment));
  });

  it("セッション失効も「送信していない」側（記録を消し、失効として返す）", async () => {
    const deps = stubDeps([new Error(`${ZAIM_SESSION_EXPIRED}:https://id.kufu.jp/`)]);
    const outcome = await createZaimWebMemoEdit({ ...VALID, requestId: "expired-1" }, deps);

    assert.ok(!outcome.ok && outcome.kind === "rejected");
    assert.match(outcome.ok === false ? outcome.reason : "", /ログインセッションが失効/);
    assert.equal(
      (await readRecords()).some((record) => record.requestId === "expired-1"),
      false,
    );
  });

  it("メモを消す（空文字）も同じ流れで書き換える", async () => {
    const deps = stubDeps([SCRIPT_OK]);
    const outcome = await createZaimWebMemoEdit({ ...VALID, requestId: "clear-1", comment: "" }, deps);

    assert.ok(outcome.ok);
    assert.equal(JSON.parse(deps.options[0]?.env?.["ZAIM_WEB_MEMO_EDIT_INPUT"] ?? "{}").comment, "");
  });

  it("dryRun は記録を残さない", async () => {
    const deps = stubDeps([
      JSON.stringify({
        submitted: false,
        url: "https://zaim.net/money/5001/edit",
        filled: { comment: VALID.comment, amount: 1284, date: "2026年9月17日(木)" },
      }),
    ]);
    const outcome = await createZaimWebMemoEdit({ ...VALID, requestId: "dry-1", dryRun: true }, deps);

    assert.ok(outcome.ok);
    assert.equal(outcome.moneyId, VALID.moneyId);
    assert.equal(
      (await readRecords()).some((record) => record.requestId === "dry-1"),
      false,
    );
  });

  it("保存していない応答が返ったら失敗させる（記録は残す）", async () => {
    const deps = stubDeps([
      JSON.stringify({ submitted: false, url: "u", filled: { comment: "", amount: 1284, date: "" } }),
    ]);
    const outcome = await createZaimWebMemoEdit({ ...VALID, requestId: "not-submitted" }, deps);
    assert.ok(!outcome.ok && outcome.kind === "failed");

    const record = (await readRecords()).find((item) => item.requestId === "not-submitted");
    assert.equal(record?.state, "sending");
  });

  it("応答がJSONでなければ失敗させる（記録は残す）", async () => {
    const deps = stubDeps(["<html>error</html>"]);
    const outcome = await createZaimWebMemoEdit({ ...VALID, requestId: "broken-json" }, deps);
    assert.ok(!outcome.ok && outcome.kind === "failed");

    const record = (await readRecords()).find((item) => item.requestId === "broken-json");
    assert.equal(record?.state, "sending");
  });
});
