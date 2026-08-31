import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, describe, it } from "node:test";
import { ZAIM_SESSION_EXPIRED } from "./errors.ts";
import type { ZaimScriptDeps, ZaimScriptOptions } from "./session.ts";

// 冪等記録は本番の置き場を避ける。パスはモジュール読み込み時に確定するため、import より前に。
const dir = await mkdtemp(join(tmpdir(), "aide-zaim-web-payment-test-"));
process.env["AIDE_ZAIM_WEB_PAYMENT_LOG_PATH"] = join(dir, "zaim-web-payments.json");
const { classifyWebFailure, createZaimWebPayment, normalizeWebPaymentInput } = await import(
  "./web-payment.ts"
);

/**
 * Web版の入力画面からの登録（#214）。
 *
 * Playwrightを起動する本体は `scripts/web-payment.mjs` にあり、そちらの当て方は
 * `scripts/receipt-form.test.ts` で押さえている。ここで見るのは**入力の検査**と、
 * **失敗したときにZaimに何が残っているかの判断**——つまり二重登録を防ぐ側の分岐。
 */

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const VALID = {
  requestId: "asset-manager:receipt-item:1",
  amount: 1880,
  date: "2026-08-29",
  name: "ピザ",
  place: "ドミノ・ピザ 高槻真上町店",
  categoryName: "食費",
  genreName: "外食",
  fromAccountId: 21678522,
};

const SCRIPT_OK = JSON.stringify({
  submitted: true,
  url: "https://zaim.net/money/new",
  resultUrl: "https://zaim.net/money",
  filled: {
    name: "ピザ",
    genre: "外食",
    amount: 1880,
    comment: "#asset-manager:receipt-item:1",
    place: "ドミノ・ピザ 高槻真上町店",
    date: "2026年8月29日(土)",
    accountName: "三井住友カード VISA",
  },
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

async function readRecords(): Promise<{ requestId: string; state: string }[]> {
  try {
    return JSON.parse(await readFile(process.env["AIDE_ZAIM_WEB_PAYMENT_LOG_PATH"]!, "utf8")) as {
      requestId: string;
      state: string;
    }[];
  } catch {
    return [];
  }
}

describe("normalizeWebPaymentInput", () => {
  it("そろっていれば通す", () => {
    const result = normalizeWebPaymentInput({ ...VALID, comment: " レシート取込 " });
    assert.ok("input" in result);
    assert.equal(result.input.comment, "レシート取込");
    assert.equal(result.input.fromAccountId, 21678522);
  });

  it("品目・店舗・カテゴリ・出金元は必須（欠けた明細は置き換えに載らない）", () => {
    // 置き換えの成立条件が「品目・出金元・日付・金額の一致」なので、欠けたものを作っても意味が無い。
    for (const key of ["name", "place", "categoryName", "genreName", "fromAccountId"] as const) {
      const body: Record<string, unknown> = { ...VALID };
      delete body[key];
      const result = normalizeWebPaymentInput(body);
      assert.ok("error" in result, `${key} が無くても通ってしまいます`);
    }
  });

  it("空白だけの品目名は「未指定」として弾く", () => {
    const result = normalizeWebPaymentInput({ ...VALID, name: "   " });
    assert.ok("error" in result);
  });

  it("実在しない日付を弾く（Zaim側で丸められて別の日に登録される）", () => {
    assert.ok("error" in normalizeWebPaymentInput({ ...VALID, date: "2026-02-31" }));
    assert.ok("error" in normalizeWebPaymentInput({ ...VALID, date: "2026/08/29" }));
  });

  it("0円・小数・上限超えの金額を弾く", () => {
    assert.ok("error" in normalizeWebPaymentInput({ ...VALID, amount: 0 }));
    assert.ok("error" in normalizeWebPaymentInput({ ...VALID, amount: 1.5 }));
    assert.ok("error" in normalizeWebPaymentInput({ ...VALID, amount: 100_000_001 }));
  });

  it("メモと冪等キーの合計が上限を超えるものは、画面を開く前に断る", () => {
    // メモには冪等キーも書き込む。長いまま進むと、送信の直前で止まるだけ無駄が増える。
    const result = normalizeWebPaymentInput({ ...VALID, comment: "x".repeat(95) });
    assert.ok("error" in result);
    assert.match(result.error, /合計が 100 文字を超えます/);
  });

  it("requestId に制御文字を許さない（記録にもメモにも入る）", () => {
    assert.ok("error" in normalizeWebPaymentInput({ ...VALID, requestId: "a\nb" }));
  });
});

describe("classifyWebFailure", () => {
  it("送信の前に止まった失敗は rejected（Zaimには何も無い）", () => {
    const result = classifyWebFailure("Error: ZAIM_RECEIPT_FORM:金額を確定できませんでした");
    assert.equal(result.kind, "rejected");
    // 何と噛み合わなかったのかを残す。Zaimの仕様変更を人が読んで気づけるように。
    assert.match(result.reason, /金額を確定できませんでした/);
  });

  it("送信した後の失敗は failed（登録された可能性が残る）", () => {
    const result = classifyWebFailure("Error: ZAIM_RECEIPT_SUBMITTED:画面が変わりませんでした");
    assert.equal(result.kind, "failed");
  });

  it("見分けのつかない失敗は failed に倒す（記録を消さない側）", () => {
    assert.equal(classifyWebFailure("Command failed: timeout").kind, "failed");
  });
});

describe("createZaimWebPayment", () => {
  it("登録できたら記録を確定し、moneyId は null で返す", async () => {
    const deps = stubDeps([SCRIPT_OK]);
    const outcome = await createZaimWebPayment({ ...VALID, requestId: "ok-1" }, deps);

    assert.deepEqual(deps.calls, ["web-payment.mjs"]);
    assert.ok(outcome.ok);
    // 画面にIDが出ないので返せない。呼び出し元はメモに載った冪等キーで引く。
    assert.equal(outcome.moneyId, null);
    assert.equal(outcome.duplicated, false);
    assert.equal(outcome.registered?.accountName, "三井住友カード VISA");

    const record = (await readRecords()).find((item) => item.requestId === "ok-1");
    assert.equal(record?.state, "done");
  });

  it("登録の内容は環境変数で渡す（`ps` に金額や店名を出さない）", async () => {
    const deps = stubDeps([SCRIPT_OK]);
    await createZaimWebPayment({ ...VALID, requestId: "env-1" }, deps);

    const passed = deps.options[0]?.env?.["ZAIM_WEB_PAYMENT_INPUT"];
    assert.ok(passed);
    assert.equal(JSON.parse(passed).requestId, "env-1");
  });

  it("一時的な失敗をやり直さない（やり直すと同じ明細が2件できる）", async () => {
    const deps = stubDeps([
      new Error("page.goto: net::ERR_ADDRESS_UNREACHABLE"),
      SCRIPT_OK,
    ]);
    const outcome = await createZaimWebPayment({ ...VALID, requestId: "no-retry" }, deps);

    assert.equal(deps.calls.length, 1, "やり直してはいけない");
    assert.equal(outcome.ok, false);
    assert.equal(deps.options[0]?.retryTransient, false);

    // 登録された可能性が残るため、記録は残したまま次の再送を止める。
    const record = (await readRecords()).find((item) => item.requestId === "no-retry");
    assert.equal(record?.state, "sending");
  });

  it("同じ requestId の再送は画面を開かず duplicated で返す", async () => {
    const first = stubDeps([SCRIPT_OK]);
    await createZaimWebPayment({ ...VALID, requestId: "dup-1" }, first);

    const second = stubDeps([]);
    const outcome = await createZaimWebPayment({ ...VALID, requestId: "dup-1" }, second);
    assert.deepEqual(second.calls, [], "登録済みならZaimを開かない");
    assert.ok(outcome.ok);
    assert.equal(outcome.duplicated, true);
  });

  it("結果が確定していない再送は conflict で止める", async () => {
    const failing = stubDeps([new Error("ZAIM_RECEIPT_SUBMITTED:確認できませんでした")]);
    await createZaimWebPayment({ ...VALID, requestId: "conflict-1" }, failing);

    const retry = stubDeps([]);
    const outcome = await createZaimWebPayment({ ...VALID, requestId: "conflict-1" }, retry);
    assert.deepEqual(retry.calls, [], "結果が不明なまま送り直さない");
    assert.equal(outcome.ok, false);
    assert.ok(!outcome.ok && outcome.kind === "conflict");
  });

  it("送信の前に止まった失敗は記録を消し、直せば送り直せる", async () => {
    const failing = stubDeps([new Error("ZAIM_RECEIPT_FORM:カテゴリが候補に見つかりません")]);
    const outcome = await createZaimWebPayment({ ...VALID, requestId: "rejected-1" }, failing);
    assert.ok(!outcome.ok && outcome.kind === "rejected");

    assert.equal(
      (await readRecords()).some((record) => record.requestId === "rejected-1"),
      false,
      "Zaimには何も登録されていないので、記録を残して再送を塞いではいけない",
    );
  });

  it("セッション失効も「送信していない」側（記録を消し、失効として返す）", async () => {
    // 失効はページを開いた時点で分かるため、必ず送信より前で起きる。
    const deps = stubDeps([new Error(`${ZAIM_SESSION_EXPIRED}:https://id.kufu.jp/`)]);
    const outcome = await createZaimWebPayment({ ...VALID, requestId: "expired-1" }, deps);

    assert.ok(!outcome.ok && outcome.kind === "rejected");
    assert.match(outcome.ok === false ? outcome.reason : "", /ログインセッションが失効/);
    assert.equal(
      (await readRecords()).some((record) => record.requestId === "expired-1"),
      false,
    );
  });

  it("dryRun は記録を残さない（本番の登録が「登録済み」で弾かれないように）", async () => {
    const deps = stubDeps([
      JSON.stringify({
        submitted: false,
        url: "https://zaim.net/money/new",
        filled: JSON.parse(SCRIPT_OK).filled,
      }),
    ]);
    const outcome = await createZaimWebPayment({ ...VALID, requestId: "dry-1", dryRun: true }, deps);

    assert.ok(outcome.ok);
    assert.equal(
      (await readRecords()).some((record) => record.requestId === "dry-1"),
      false,
    );
  });

  it("送信していない応答が返ったら失敗させる（記録は残す）", async () => {
    const deps = stubDeps([
      JSON.stringify({ submitted: false, url: "u", filled: JSON.parse(SCRIPT_OK).filled }),
    ]);
    const outcome = await createZaimWebPayment({ ...VALID, requestId: "not-submitted" }, deps);
    assert.ok(!outcome.ok && outcome.kind === "failed");

    const record = (await readRecords()).find((item) => item.requestId === "not-submitted");
    assert.equal(record?.state, "sending");
  });

  it("応答がJSONでなければ失敗させる（記録は残す）", async () => {
    const deps = stubDeps(["<html>error</html>"]);
    const outcome = await createZaimWebPayment({ ...VALID, requestId: "broken-json" }, deps);
    assert.ok(!outcome.ok && outcome.kind === "failed");

    const record = (await readRecords()).find((item) => item.requestId === "broken-json");
    assert.equal(record?.state, "sending");
  });
});
