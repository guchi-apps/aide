import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, describe, it } from "node:test";
import { ZAIM_SESSION_EXPIRED } from "./errors.ts";
import type { ZaimScriptDeps, ZaimScriptOptions } from "./session.ts";

// 冪等記録は本番の置き場を避ける。パスはモジュール読み込み時に確定するため、import より前に。
const dir = await mkdtemp(join(tmpdir(), "aide-zaim-web-genre-edit-test-"));
process.env["AIDE_ZAIM_WEB_GENRE_EDIT_LOG_PATH"] = join(dir, "zaim-web-genre-edits.json");
const { classifyWebGenreEditFailure, createZaimWebGenreEdit, normalizeWebGenreEditInput } =
  await import("./web-genre-edit.ts");

/**
 * 既存明細のカテゴリ・内訳の変更（#273）。
 *
 * Playwrightを起動する本体は `scripts/edit-genre.mjs` にあり、当て方の判断は
 * `scripts/receipt-form.mjs`（`web-payment.mjs` と共用）で押さえている。ここで見るのは
 * **入力の検査**と、**失敗したときにZaimに何が残っているかの判断**——つまり二重実行を
 * 防ぐ側の分岐。`web-payment.test.ts` と同じ流儀。
 */

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const VALID = {
  requestId: "asset-manager:genre-suggestion:1",
  moneyId: 10228209053,
  amount: 1238,
  date: "2026-09-02",
  categoryName: "食費",
  genreName: "調理食品",
};

const SCRIPT_OK = JSON.stringify({
  submitted: true,
  url: "https://zaim.net/money/10228209053/edit",
  resultUrl: "https://zaim.net/money",
  filled: { genre: "調理食品", amount: 1238, date: "2026年9月2日(水)" },
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

describe("normalizeWebGenreEditInput", () => {
  it("そろっていれば通す", () => {
    const result = normalizeWebGenreEditInput(VALID);
    assert.ok("input" in result);
    assert.equal(result.input.moneyId, 10228209053);
  });

  it("requestId・moneyId・date・amount・categoryName・genreName は必須", () => {
    for (const key of ["requestId", "moneyId", "date", "amount", "categoryName", "genreName"] as const) {
      const body: Record<string, unknown> = { ...VALID };
      delete body[key];
      const result = normalizeWebGenreEditInput(body);
      assert.ok("error" in result, `${key} が無くても通ってしまいます`);
    }
  });

  it("moneyId は正の整数でなければ弾く", () => {
    assert.ok("error" in normalizeWebGenreEditInput({ ...VALID, moneyId: 0 }));
    assert.ok("error" in normalizeWebGenreEditInput({ ...VALID, moneyId: 1.5 }));
    assert.ok("error" in normalizeWebGenreEditInput({ ...VALID, moneyId: "10228209053" }));
  });

  it("実在しない日付を弾く", () => {
    assert.ok("error" in normalizeWebGenreEditInput({ ...VALID, date: "2026-02-31" }));
  });

  it("0円・小数の金額を弾く", () => {
    assert.ok("error" in normalizeWebGenreEditInput({ ...VALID, amount: 0 }));
    assert.ok("error" in normalizeWebGenreEditInput({ ...VALID, amount: 1.5 }));
  });

  it("requestId に制御文字を許さない", () => {
    assert.ok("error" in normalizeWebGenreEditInput({ ...VALID, requestId: "a\nb" }));
  });

  it("name・place・fromAccountId は受け取らない（この経路は変えないため不要）", () => {
    const result = normalizeWebGenreEditInput(VALID);
    assert.ok("input" in result);
    assert.ok(!("name" in result.input));
    assert.ok(!("place" in result.input));
    assert.ok(!("fromAccountId" in result.input));
  });
});

describe("classifyWebGenreEditFailure", () => {
  it("送信の前に止まった失敗は rejected（Zaimには何も無い）", () => {
    const result = classifyWebGenreEditFailure("Error: ZAIM_RECEIPT_FORM:金額が一致しません");
    assert.equal(result.kind, "rejected");
    assert.match(result.reason, /金額が一致しません/);
  });

  it("送信した後の失敗は failed（変更された可能性が残る）", () => {
    const result = classifyWebGenreEditFailure("Error: ZAIM_RECEIPT_SUBMITTED:画面が変わりませんでした");
    assert.equal(result.kind, "failed");
  });

  it("見分けのつかない失敗は failed に倒す（記録を消さない側）", () => {
    assert.equal(classifyWebGenreEditFailure("Command failed: timeout").kind, "failed");
  });
});

describe("createZaimWebGenreEdit", () => {
  it("変更できたら記録を確定し、渡した moneyId をそのまま返す", async () => {
    const deps = stubDeps([SCRIPT_OK]);
    const outcome = await createZaimWebGenreEdit({ ...VALID, requestId: "ok-1" }, deps);

    assert.deepEqual(deps.calls, ["edit-genre.mjs"]);
    assert.ok(outcome.ok);
    assert.equal(outcome.moneyId, VALID.moneyId);
    assert.equal(outcome.duplicated, false);

    const record = (await readRecords()).find((item) => item.requestId === "ok-1");
    assert.equal(record?.state, "done");
    assert.equal(record?.moneyId, VALID.moneyId);
  });

  it("変更の内容は環境変数で渡す（`ps` に moneyId や金額を出さない）", async () => {
    const deps = stubDeps([SCRIPT_OK]);
    await createZaimWebGenreEdit({ ...VALID, requestId: "env-1" }, deps);

    const passed = deps.options[0]?.env?.["ZAIM_WEB_GENRE_EDIT_INPUT"];
    assert.ok(passed);
    assert.equal(JSON.parse(passed).requestId, "env-1");
  });

  it("一時的な失敗をやり直さない（やり直すと同じ明細へ二重に変更が送られる）", async () => {
    const deps = stubDeps([new Error("page.goto: net::ERR_ADDRESS_UNREACHABLE"), SCRIPT_OK]);
    const outcome = await createZaimWebGenreEdit({ ...VALID, requestId: "no-retry" }, deps);

    assert.equal(deps.calls.length, 1, "やり直してはいけない");
    assert.equal(outcome.ok, false);
    assert.equal(deps.options[0]?.retryTransient, false);

    const record = (await readRecords()).find((item) => item.requestId === "no-retry");
    assert.equal(record?.state, "sending");
  });

  it("同じ requestId の再送は画面を開かず duplicated と moneyId を返す", async () => {
    const first = stubDeps([SCRIPT_OK]);
    await createZaimWebGenreEdit({ ...VALID, requestId: "dup-1" }, first);

    const second = stubDeps([]);
    const outcome = await createZaimWebGenreEdit({ ...VALID, requestId: "dup-1" }, second);
    assert.deepEqual(second.calls, [], "変更済みならZaimを開かない");
    assert.ok(outcome.ok);
    assert.equal(outcome.duplicated, true);
    assert.equal(outcome.moneyId, VALID.moneyId);
  });

  it("結果が確定していない再送は、新規登録と違い塞がずに画面を開いて送り直せる（べき等なため）", async () => {
    const failing = stubDeps([new Error("ZAIM_RECEIPT_SUBMITTED:確認できませんでした")]);
    const first = await createZaimWebGenreEdit({ ...VALID, requestId: "retry-1" }, failing);
    assert.ok(!first.ok && first.kind === "failed");

    const retry = stubDeps([SCRIPT_OK]);
    const outcome = await createZaimWebGenreEdit({ ...VALID, requestId: "retry-1" }, retry);
    assert.deepEqual(retry.calls, ["edit-genre.mjs"], "結果不明でも画面を開いて送り直せること");
    assert.ok(outcome.ok);
    assert.equal(outcome.duplicated, false);
    assert.equal(outcome.moneyId, VALID.moneyId);

    const record = (await readRecords()).find((item) => item.requestId === "retry-1");
    assert.equal(record?.state, "done");
  });

  it("開いた明細が一致しない（取り違え）も送信前の失敗として記録を消す", async () => {
    const failing = stubDeps([
      new Error("ZAIM_RECEIPT_FORM:開いた明細の金額が一致しません（期待 1238、実際 500）"),
    ]);
    const outcome = await createZaimWebGenreEdit({ ...VALID, requestId: "mismatch-1" }, failing);
    assert.ok(!outcome.ok && outcome.kind === "rejected");
    assert.match(outcome.ok === false ? outcome.reason : "", /一致しません/);

    assert.equal(
      (await readRecords()).some((record) => record.requestId === "mismatch-1"),
      false,
      "Zaimには何も変更されていないので、記録を残して再送を塞いではいけない",
    );
  });

  it("セッション失効も「送信していない」側（記録を消し、失効として返す）", async () => {
    const deps = stubDeps([new Error(`${ZAIM_SESSION_EXPIRED}:https://id.kufu.jp/`)]);
    const outcome = await createZaimWebGenreEdit({ ...VALID, requestId: "expired-1" }, deps);

    assert.ok(!outcome.ok && outcome.kind === "rejected");
    assert.match(outcome.ok === false ? outcome.reason : "", /ログインセッションが失効/);
    assert.equal(
      (await readRecords()).some((record) => record.requestId === "expired-1"),
      false,
    );
  });

  it("dryRun は記録を残さない", async () => {
    const deps = stubDeps([
      JSON.stringify({
        submitted: false,
        url: "https://zaim.net/money/10228209053/edit",
        filled: { genre: "調理食品", amount: 1238, date: "2026年9月2日(水)" },
      }),
    ]);
    const outcome = await createZaimWebGenreEdit({ ...VALID, requestId: "dry-1", dryRun: true }, deps);

    assert.ok(outcome.ok);
    assert.equal(outcome.moneyId, VALID.moneyId);
    assert.equal(
      (await readRecords()).some((record) => record.requestId === "dry-1"),
      false,
    );
  });

  it("保存していない応答が返ったら失敗させる（記録は残す）", async () => {
    const deps = stubDeps([
      JSON.stringify({
        submitted: false,
        url: "u",
        filled: { genre: "調理食品", amount: 1238, date: "2026年9月2日(水)" },
      }),
    ]);
    const outcome = await createZaimWebGenreEdit({ ...VALID, requestId: "not-submitted" }, deps);
    assert.ok(!outcome.ok && outcome.kind === "failed");

    const record = (await readRecords()).find((item) => item.requestId === "not-submitted");
    assert.equal(record?.state, "sending");
  });

  it("応答がJSONでなければ失敗させる（記録は残す）", async () => {
    const deps = stubDeps(["<html>error</html>"]);
    const outcome = await createZaimWebGenreEdit({ ...VALID, requestId: "broken-json" }, deps);
    assert.ok(!outcome.ok && outcome.kind === "failed");

    const record = (await readRecords()).find((item) => item.requestId === "broken-json");
    assert.equal(record?.state, "sending");
  });
});
