import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import type { ToolResult } from "../types.ts";

// 本番の記録・キャッシュを汚さないよう、読み込み前に置き場を一時ディレクトリへ差し替える。
// どちらもモジュール読み込み時に確定するため、import より前に設定する必要がある。
const dir = await mkdtemp(join(tmpdir(), "aide-mcp-zaim-test-"));
process.env["AIDE_CACHE_DIR"] = join(dir, "cache");
process.env["AIDE_ZAIM_PAYMENT_LOG_PATH"] = join(dir, "zaim-payments.json");

const { MCP_MAX_AMOUNT, paymentKey, resolveNames, zaimPaymentTool } = await import("./zaim.ts");
const { nextRequestId } = await import("../../core/connectors/zaim/idempotency.ts");
const { ZAIM_MASTER_CACHE_KEY } = await import("../../core/views/zaim-master.ts");
const { writeCache } = await import("../../core/cache/store.ts");

/**
 * **この経路は取り消せない。** 二重登録の判定と、会話由来の入力に対する歯止めを押さえておく。
 * Zaimへ実際に送る手前までしか踏まない（テストから外部サービスは叩かない）。
 */

const CTX = { sessionId: null };

const MASTER = {
  accounts: [{ id: 1, name: "現金" }],
  categories: [
    { id: 101, name: "食費" },
    { id: 102, name: "日用雑貨" },
  ],
  genres: [
    { id: 10101, name: "食料品", categoryId: 101 },
    { id: 10201, name: "消耗品", categoryId: 102 },
  ],
};

const VALID = { amount: 1200, date: "2026-08-19", categoryId: 101, genreId: 10101, fromAccountId: 1 };

function input(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "test",
    amount: 1200,
    date: "2026-08-19",
    categoryId: 101,
    genreId: 10101,
    ...overrides,
  };
}

function parse(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(process.env["AIDE_ZAIM_PAYMENT_LOG_PATH"]!, { force: true });
  // 資格情報が無いと「未設定」で早々に返ってしまい、その先の分岐に届かない。
  process.env["AIDE_ZAIM_CONSUMER_KEY"] = "ck";
  process.env["AIDE_ZAIM_CONSUMER_SECRET"] = "cs";
  process.env["AIDE_ZAIM_ACCESS_TOKEN"] = "at";
  process.env["AIDE_ZAIM_ACCESS_TOKEN_SECRET"] = "ats";
  // マスタを新しいキャッシュとして置く。これが無いと ID の検査でZaimを叩きに行く。
  await writeCache(ZAIM_MASTER_CACHE_KEY, "zaim", MASTER);
});

describe("paymentKey", () => {
  it("同じ内容からは同じキーになる", () => {
    assert.equal(paymentKey(input()), paymentKey(input({ requestId: "別のID" })));
  });

  it("金額・日付・分類・店名・品名が変われば別のキーになる", () => {
    const base = paymentKey(input());
    for (const overrides of [
      { amount: 1201 },
      { date: "2026-08-18" },
      { categoryId: 102 },
      { genreId: 10201 },
      { fromAccountId: 1 },
      { place: "セブンイレブン" },
      { name: "牛乳" },
    ]) {
      assert.notEqual(paymentKey(input(overrides)), base, JSON.stringify(overrides));
    }
  });

  it("comment はキーに混ぜない（書き換えだけで二重登録の判定をすり抜けさせない）", () => {
    assert.equal(paymentKey(input({ comment: "メモ" })), paymentKey(input()));
  });

  it("項目の境目が曖昧にならない", () => {
    // 単純に連結すると place="A|B" と place="A" / name="B" が同じ材料になる。
    assert.notEqual(
      paymentKey(input({ place: "A|B" })),
      paymentKey(input({ place: "A", name: "B" })),
    );
  });
});

describe("resolveNames", () => {
  const master = { ...MASTER, fetchedAt: new Date().toISOString(), ageMinutes: 0, stale: false };

  it("実在するIDの組み合わせなら名前を引ける", () => {
    const outcome = resolveNames(master, input({ fromAccountId: 1 }));
    assert.deepEqual(outcome, {
      ok: true,
      names: { accountName: "現金", categoryName: "食費", genreName: "食料品" },
    });
  });

  it("fromAccountId を省いた場合は accountName が null になる", () => {
    const outcome = resolveNames(master, input());
    assert.equal(outcome.ok && outcome.names.accountName, null);
  });

  it("カテゴリと噛み合わないジャンルは弾く", () => {
    // Zaimは mapping=1 で両方をIDで受け取るため、ここを通すと意図しない分類で登録される。
    const outcome = resolveNames(master, input({ genreId: 10201 }));
    assert.equal(outcome.ok, false);
  });

  it("存在しないIDは弾く", () => {
    assert.equal(resolveNames(master, input({ categoryId: 999 })).ok, false);
    assert.equal(resolveNames(master, input({ genreId: 999 })).ok, false);
    assert.equal(resolveNames(master, input({ fromAccountId: 999 })).ok, false);
  });
});

describe("aide_zaim_payment", () => {
  it("資格情報が無ければZaimへ何も送らない", async () => {
    delete process.env["AIDE_ZAIM_ACCESS_TOKEN"];
    const body = parse(await zaimPaymentTool.handler({ ...VALID }, CTX));
    assert.equal(body["ok"], false);
    assert.match(String(body["reason"]), /未設定/);
  });

  it("MCP経由の上限額を超える金額は登録しない", async () => {
    const body = parse(await zaimPaymentTool.handler({ ...VALID, amount: MCP_MAX_AMOUNT + 1 }, CTX));
    assert.equal(body["ok"], false);
    assert.equal(body["kind"], "invalid");
    assert.match(String(body["reason"]), /amount/);
  });

  it("上限額ちょうどは上限額の判定で弾かない", async () => {
    // 通す側の境界。ここで弾くと、上限の意味が1円ずれる。
    const body = parse(await zaimPaymentTool.handler({ ...VALID, amount: MCP_MAX_AMOUNT, date: "2999-01-01" }, CTX));
    assert.match(String(body["reason"]), /未来/);
  });

  it("未来の日付は登録しない", async () => {
    const body = parse(await zaimPaymentTool.handler({ ...VALID, date: "2999-12-31" }, CTX));
    assert.equal(body["ok"], false);
    assert.equal(body["kind"], "invalid");
    assert.match(String(body["reason"]), /未来/);
  });

  it("既存の検査（実在しない日付など）はそのまま効く", async () => {
    const body = parse(await zaimPaymentTool.handler({ ...VALID, date: "2026-02-31" }, CTX));
    assert.equal(body["ok"], false);
    assert.equal(body["kind"], "invalid");
  });

  it("同じ内容が登録済みなら、登録せずに止まる", async () => {
    const base = paymentKey(input({ fromAccountId: 1 }));
    await writeFile(
      process.env["AIDE_ZAIM_PAYMENT_LOG_PATH"]!,
      JSON.stringify([{ requestId: base, moneyId: 555, at: "2026-08-19T10:00:00.000Z" }]),
      "utf8",
    );

    const body = parse(await zaimPaymentTool.handler({ ...VALID }, CTX));
    assert.equal(body["ok"], false);
    assert.equal(body["kind"], "duplicate");
    assert.deepEqual(body["existing"], [{ moneyId: 555, at: "2026-08-19T10:00:00.000Z" }]);
  });

  it("結果が確定していない記録があれば、allowDuplicate でも跨がせない", async () => {
    // ここが二重登録の最後の砦。連番で別の鍵にすると createZaimPayment() の conflict 判定
    // （requestId の完全一致）をすり抜け、そのままZaimへ送られる。
    const base = paymentKey(input({ fromAccountId: 1 }));
    await writeFile(
      process.env["AIDE_ZAIM_PAYMENT_LOG_PATH"]!,
      JSON.stringify([{ requestId: base, moneyId: null, at: "2026-08-19T10:00:00.000Z" }]),
      "utf8",
    );

    for (const extra of [{}, { allowDuplicate: true }]) {
      const body = parse(await zaimPaymentTool.handler({ ...VALID, ...extra }, CTX));
      assert.equal(body["ok"], false);
      assert.equal(body["kind"], "conflict", JSON.stringify(extra));
    }
  });

  it("確定済みの記録だけなら allowDuplicate で別の鍵として通る", async () => {
    // 通る側は Zaim を叩くのでここでは踏まない。重複判定を抜けた先の鍵だけ確かめる。
    const base = paymentKey(input({ fromAccountId: 1 }));
    const at = "2026-08-19T10:00:00.000Z";
    assert.equal(nextRequestId(base, [{ requestId: base, moneyId: 555, at }]), `${base}#2`);
  });

  // マスタに無いIDを渡す経路はここでは踏まない。ハンドラはキャッシュに無いIDを見ると
  // `refresh: true` でZaimへ引き直しに行くため、テストから外部サービスを叩くことになる。
  // ID の検査そのものは `resolveNames` に対して上で確かめている。
});
