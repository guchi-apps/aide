import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import type { ZaimOAuthCredentials } from "./oauth.ts";

// 記録の置き場は読み込み時に確定するため、import より前に一時ディレクトリへ差し替える。
const dir = await mkdtemp(join(tmpdir(), "aide-zaim-write-test-"));
process.env["AIDE_ZAIM_PAYMENT_LOG_PATH"] = join(dir, "zaim-payments.json");
const {
  buildPaymentParams,
  classifyFailure,
  createZaimPayment,
  extractMoneyId,
  isValidDate,
  normalizePaymentInput,
} = await import("./write.ts");
const { beginPayment, completePayment } = await import("./idempotency.ts");

/**
 * ここでの間違いは**Zaimに実際の支出レコードとして残り、APIからは消せない**
 * （このコネクタは削除を持たない）。検査と、二重登録を止める分岐に絞ってテストする。
 * 署名まわりは `oauth.test.ts`。
 */

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const CREDENTIALS: ZaimOAuthCredentials = {
  consumerKey: "ck",
  consumerSecret: "cs",
  accessToken: "at",
  accessTokenSecret: "ats",
};

const VALID = {
  requestId: "car-care:fuel-log:1234",
  amount: 6800,
  date: "2026-08-19",
  categoryId: 101,
  genreId: 10101,
};

describe("normalizePaymentInput", () => {
  it("必須項目がそろっていれば通す", () => {
    const result = normalizePaymentInput({ ...VALID, fromAccountId: 55, place: " 〇〇SS ", comment: "レギュラー" });
    assert.ok("input" in result);
    assert.deepEqual(result.input, {
      ...VALID,
      fromAccountId: 55,
      place: "〇〇SS",
      comment: "レギュラー",
    });
  });

  it("任意項目は空文字なら「指定なし」として落とす", () => {
    const result = normalizePaymentInput({ ...VALID, place: "   ", name: "" });
    assert.ok("input" in result);
    assert.equal("place" in result.input, false);
    assert.equal("name" in result.input, false);
  });

  it("requestId が無ければ断る（冪等キーが無いと再送を止められない）", () => {
    const result = normalizePaymentInput({ ...VALID, requestId: "  " });
    assert.ok("error" in result);
    assert.match(result.error, /requestId/);
  });

  it("金額は1以上の整数だけを通す", () => {
    for (const amount of [0, -1, 1.5, "1200", null]) {
      assert.ok("error" in normalizePaymentInput({ ...VALID, amount }), `amount=${String(amount)} が通っている`);
    }
    assert.ok("input" in normalizePaymentInput({ ...VALID, amount: 1 }));
  });

  it("桁を1つ間違えたような金額は上限で止める", () => {
    assert.ok("error" in normalizePaymentInput({ ...VALID, amount: 100_000_001 }));
  });

  it("日付は実在する日だけを通す", () => {
    assert.ok(isValidDate("2026-08-19"));
    // 形は合っていてもZaim側で丸められ、呼び出し元のレコードと違う日で登録される。
    assert.equal(isValidDate("2026-02-31"), false);
    assert.equal(isValidDate("2026/08/19"), false);
    assert.equal(isValidDate("2026-8-19"), false);
    assert.ok("error" in normalizePaymentInput({ ...VALID, date: "2026-02-31" }));
  });

  it("カテゴリ・ジャンルは必須（AIDEは既定値を持たない）", () => {
    assert.ok("error" in normalizePaymentInput({ ...VALID, categoryId: undefined }));
    assert.ok("error" in normalizePaymentInput({ ...VALID, genreId: undefined }));
    assert.ok("error" in normalizePaymentInput({ ...VALID, categoryId: 0 }));
  });

  it("100文字を超える文字列は断る（Zaimが受け付けない）", () => {
    assert.ok("error" in normalizePaymentInput({ ...VALID, comment: "あ".repeat(101) }));
  });

  it("JSONオブジェクト以外は断る", () => {
    assert.ok("error" in normalizePaymentInput([VALID]));
    assert.ok("error" in normalizePaymentInput("payment"));
    assert.ok("error" in normalizePaymentInput(null));
  });
});

describe("buildPaymentParams", () => {
  it("mapping=1 を必ず載せる（省くと登録が通らない）", () => {
    assert.deepEqual(buildPaymentParams(VALID), {
      mapping: "1",
      category_id: "101",
      genre_id: "10101",
      amount: "6800",
      date: "2026-08-19",
    });
  });

  it("任意項目はZaimのパラメータ名へ移す", () => {
    const params = buildPaymentParams({ ...VALID, fromAccountId: 55, place: "〇〇SS", comment: "満タン" });
    assert.equal(params["from_account_id"], "55");
    assert.equal(params["place"], "〇〇SS");
    assert.equal(params["comment"], "満タン");
  });
});

describe("classifyFailure", () => {
  it("Zaimが内容を拒んだ場合は rejected（登録されていないと言い切れる）", () => {
    assert.equal(classifyFailure(new Response("", { status: 400 })).kind, "rejected");
    assert.equal(classifyFailure(new Response("", { status: 401 })).kind, "rejected");
  });

  it("打ち切り・レート制限・障害は failed（登録された可能性が残る）", () => {
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    assert.equal(classifyFailure(timeout).kind, "failed");
    assert.equal(classifyFailure(new Response("", { status: 429 })).kind, "failed");
    assert.equal(classifyFailure(new Response("", { status: 503 })).kind, "failed");
  });
});

describe("extractMoneyId", () => {
  it("money.id を拾う", () => {
    assert.equal(extractMoneyId({ money: { id: 987654321 } }), 987654321);
  });

  it("読めない形なら null", () => {
    assert.equal(extractMoneyId({ money: {} }), null);
    assert.equal(extractMoneyId("ok"), null);
  });
});

describe("createZaimPayment", () => {
  /** fetch が呼ばれたら失敗させる。「Zaimへ送っていない」ことを確かめるため。 */
  async function withoutFetch<T>(task: () => Promise<T>): Promise<T> {
    const original = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("Zaimへ送ってはいけない場面で fetch が呼ばれた");
    }) as typeof fetch;
    try {
      return await task();
    } finally {
      globalThis.fetch = original;
    }
  }

  it("登録済みの requestId はZaimへ送らず、前回の money_id を返す", async () => {
    await beginPayment("already-done");
    await completePayment("already-done", 555);

    const outcome = await withoutFetch(() =>
      createZaimPayment(CREDENTIALS, { ...VALID, requestId: "already-done" }),
    );
    assert.deepEqual(outcome, { ok: true, moneyId: 555, duplicated: true });
  });

  it("前回の結果が不明な requestId は conflict で止める（勝手に再送しない）", async () => {
    await beginPayment("unresolved-1");

    const outcome = await withoutFetch(() =>
      createZaimPayment(CREDENTIALS, { ...VALID, requestId: "unresolved-1" }),
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.kind, "conflict");
  });
});
