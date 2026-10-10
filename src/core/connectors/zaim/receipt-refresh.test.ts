import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ZAIM_AUTO_RELOGIN_FAILED, ZAIM_SESSION_EXPIRED } from "./errors.ts";
import {
  fetchZaimReceiptDetail,
  isZaimReceiptDetailCacheKey,
  normalizeReceiptRefreshInput,
  zaimReceiptDetailCacheKey,
} from "./receipt-refresh.ts";
import type { ZaimScriptDeps } from "./session.ts";
import type { ZaimRawMoneyEntry, ZaimRawReceiptDetail } from "./types.ts";

const INPUT = { moneyId: 9001, date: "2026-10-09", amount: 1543 };

function deps(result: string | Error): ZaimScriptDeps & { envs: Array<Record<string, string> | undefined> } {
  const envs: Array<Record<string, string> | undefined> = [];
  return {
    envs,
    async exec(_script, options) {
      envs.push(options.env);
      if (result instanceof Error) throw result;
      return { stdout: result };
    },
    async sleep() {},
    now: () => 0,
  };
}

function raw(detail: ZaimRawReceiptDetail, overrides: Partial<ZaimRawMoneyEntry> = {}): string {
  const entry: ZaimRawMoneyEntry = {
    editUrl: "/money/9001/edit",
    isoDate: "2026-10-09",
    date: "",
    amount: "1543",
    category: "食費",
    genre: "食料品",
    account: "カード",
    toAccount: "",
    place: "スーパー",
    name: "牛乳",
    comment: "",
    detail,
    ...overrides,
  };
  return JSON.stringify({ url: "", month: "202610", entry });
}

const SEVEN_ROWS = [298, 198, 258, 128, 398, 198, 65].map((amount, index) => ({
  id: 9001 + index,
  name: `商品${index + 1}`,
  amount,
  quantity: null,
  unitPrice: null,
  discount: null,
  tax: null,
  category: "食費",
  genre: "食料品",
}));

describe("normalizeReceiptRefreshInput", () => {
  it("moneyId・date・amount を受け取る", () => {
    assert.deepEqual(normalizeReceiptRefreshInput({ ...INPUT }), { input: INPUT });
  });

  it("取り違え検知に要る date・amount と moneyId が無ければ弾く", () => {
    for (const body of [
      {},
      { ...INPUT, moneyId: 0 },
      { ...INPUT, moneyId: "9001" },
      { ...INPUT, date: "2026-02-31" },
      { ...INPUT, amount: 0 },
      { ...INPUT, amount: 1.5 },
      { moneyId: 1, date: "2026-10-09" },
      null,
      [],
    ]) {
      assert.ok("error" in normalizeReceiptRefreshInput(body), JSON.stringify(body));
    }
  });
});

describe("キャッシュキー", () => {
  it("取引idごとのキーで、形の合うものだけ受け入れる", () => {
    assert.equal(zaimReceiptDetailCacheKey(9001), "zaim-money-detail-9001");
    assert.ok(isZaimReceiptDetailCacheKey("zaim-money-detail-9001"));
    for (const key of ["zaim-money-detail-", "zaim-money-detail-0", "zaim-money-detail-1/../x", "zaim-money-detail-abc", "zaim-money-snapshot"]) {
      assert.equal(isZaimReceiptDetailCacheKey(key), false, key);
    }
  });
});

describe("fetchZaimReceiptDetail", () => {
  it("合計1,543円の取引で元の7行を complete で返し、対象idと月だけをスクリプトへ渡す", async () => {
    const d = deps(raw({ status: "complete", items: SEVEN_ROWS }));
    const outcome = await fetchZaimReceiptDetail(INPUT, d);

    assert.ok(outcome.ok);
    assert.equal(outcome.entry.itemsStatus, "complete");
    assert.equal(outcome.entry.items?.length, 7);
    assert.equal(outcome.entry.items?.reduce((sum, item) => sum + item.amount, 0), 1543);
    assert.deepEqual(JSON.parse(d.envs[0]?.["ZAIM_RECEIPT_REFRESH_INPUT"] ?? ""), { month: "202610", moneyId: 9001 });
  });

  it("件数か合計が合わない partial は items を付けたまま partial で返す", async () => {
    const outcome = await fetchZaimReceiptDetail(
      INPUT,
      deps(raw({ status: "partial", items: SEVEN_ROWS.slice(0, 5), reason: "商品行が5件" })),
    );
    assert.ok(outcome.ok);
    assert.equal(outcome.entry.itemsStatus, "partial");
    assert.equal(outcome.entry.itemsNote, "商品行が5件");
    assert.equal(outcome.entry.items?.length, 5);
  });

  it("内訳の読み取りに失敗した取引は成功にせず、items も返さない", async () => {
    const outcome = await fetchZaimReceiptDetail(
      INPUT,
      deps(raw({ status: "failed", reason: "編集画面を取得できませんでした（HTTP 500）" })),
    );
    assert.ok(!outcome.ok);
    assert.equal(outcome.kind, "detail_failed");
    assert.match(outcome.reason, /HTTP 500/);
  });

  it("子明細を持たない取引は none（確かめたうえで内訳なし）", async () => {
    const outcome = await fetchZaimReceiptDetail(INPUT, deps(raw({ status: "none" })));
    assert.ok(outcome.ok);
    assert.equal(outcome.entry.itemsStatus, "none");
    assert.equal(outcome.entry.items, undefined);
  });

  it("月の一覧に対象が無ければ not_found", async () => {
    const outcome = await fetchZaimReceiptDetail(INPUT, deps(JSON.stringify({ url: "", month: "202610", entry: null })));
    assert.ok(!outcome.ok);
    assert.equal(outcome.kind, "not_found");
  });

  it("日付・金額が依頼と違う取引（取り違え）は not_found で止める", async () => {
    for (const overrides of [{ amount: "1500" }, { isoDate: "2026-10-08" }, { editUrl: "/money/1/edit" }]) {
      const outcome = await fetchZaimReceiptDetail(INPUT, deps(raw({ status: "complete", items: SEVEN_ROWS }, overrides)));
      assert.ok(!outcome.ok, JSON.stringify(overrides));
      assert.equal(outcome.kind, "not_found");
    }
  });

  it("セッション失効は session_expired（自動再ログインも失敗したことは文面で分かる）", async () => {
    const plain = await fetchZaimReceiptDetail(INPUT, deps(new Error(`Error: ${ZAIM_SESSION_EXPIRED}:https://zaim.net/`)));
    assert.ok(!plain.ok);
    assert.equal(plain.kind, "session_expired");

    const relogin = await fetchZaimReceiptDetail(
      INPUT,
      deps(new Error(`Error: ${ZAIM_SESSION_EXPIRED}\n${ZAIM_AUTO_RELOGIN_FAILED}`)),
    );
    assert.ok(!relogin.ok);
    assert.match(relogin.reason, new RegExp(ZAIM_AUTO_RELOGIN_FAILED));
  });

  it("画面操作・通信の失敗は fetch_failed。一時的な失敗でもやり直さない", async () => {
    const d = deps(new Error("page.goto: net::ERR_ADDRESS_UNREACHABLE at https://zaim.net/"));
    const outcome = await fetchZaimReceiptDetail(INPUT, d);
    assert.ok(!outcome.ok);
    assert.equal(outcome.kind, "fetch_failed");
    assert.equal(d.envs.length, 1);
  });

  it("スクリプトの応答が壊れていれば fetch_failed", async () => {
    const outcome = await fetchZaimReceiptDetail(INPUT, deps("not json"));
    assert.ok(!outcome.ok);
    assert.equal(outcome.kind, "fetch_failed");
  });
});
