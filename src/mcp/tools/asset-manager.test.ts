import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { assetManagerImportPaymentTool } from "./asset-manager.ts";

const SECRET = "test-asset-manager-secret";

function parsed(result: Awaited<ReturnType<typeof assetManagerImportPaymentTool.handler>>): unknown {
  return JSON.parse(result.content[0]!.text);
}

describe("asset_manager_import_payment", () => {
  it("入力スキーマでgmailMessageIdとconfidenceを必須にする", () => {
    assert.deepEqual(assetManagerImportPaymentTool.inputSchema.required, ["gmailMessageId", "confidence"]);
  });

  it("Asset ManagerへBearer認証付きでsourceを付与して送る", async () => {
    process.env["AIDE_ASSET_MANAGER_URL"] = "https://asset.example.test/";
    process.env["AIDE_ASSET_MANAGER_ZAIM_SYNC_SECRET"] = SECRET;
    const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
      assert.equal(input, "https://asset.example.test/api/receipts/import");
      assert.equal(init?.method, "POST");
      assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${SECRET}`);
      assert.deepEqual(JSON.parse(String(init?.body)), {
        source: "gmail",
        gmailMessageId: "message-1",
        confidence: 0.95,
        amount: 1490,
        sourceMetadata: { scheduleRunId: "run-1" },
      });
      return new Response(JSON.stringify({ status: "imported", receiptId: "receipt-1", zaimMoneyId: 123 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    try {
      assert.deepEqual(
        parsed(await assetManagerImportPaymentTool.handler({
          gmailMessageId: "message-1",
          confidence: 0.95,
          amount: 1490,
          sourceMetadata: { scheduleRunId: "run-1" },
        }, { sessionId: null })),
        { status: "imported", receiptId: "receipt-1", zaimMoneyId: 123 },
      );
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("HTTPエラーでもレスポンス本文を欠落させない", async () => {
    process.env["AIDE_ASSET_MANAGER_URL"] = "https://asset.example.test";
    process.env["AIDE_ASSET_MANAGER_ZAIM_SYNC_SECRET"] = SECRET;
    const fetchMock = mock.method(globalThis, "fetch", async () =>
      new Response(JSON.stringify({ status: "error", reason: "Unauthorized", receiptId: "kept" }), { status: 401 }),
    );
    try {
      assert.deepEqual(parsed(await assetManagerImportPaymentTool.handler({ gmailMessageId: "message-2", confidence: 0.2 }, { sessionId: null })), {
        status: "error",
        reason: "Unauthorized",
        receiptId: "kept",
      });
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("secret未設定時は外部へ送信しない", async () => {
    delete process.env["AIDE_ASSET_MANAGER_ZAIM_SYNC_SECRET"];
    const fetchMock = mock.method(globalThis, "fetch");
    try {
      assert.deepEqual(parsed(await assetManagerImportPaymentTool.handler({ gmailMessageId: "message-3", confidence: 0.1 }, { sessionId: null })), {
        status: "error",
        reason: "未設定（Asset Manager連携用の認証情報がありません）",
      });
      assert.equal(fetchMock.mock.callCount(), 0);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("usageを指定した場合はpayloadに含めて送る", async () => {
    process.env["AIDE_ASSET_MANAGER_URL"] = "https://asset.example.test/";
    process.env["AIDE_ASSET_MANAGER_ZAIM_SYNC_SECRET"] = SECRET;
    const fetchMock = mock.method(globalThis, "fetch", async (_input: string | URL, init?: RequestInit) => {
      assert.deepEqual(JSON.parse(String(init?.body)), {
        source: "gmail",
        gmailMessageId: "message-usage-1",
        confidence: 0.95,
        date: "2026-08-20",
        amount: 7842,
        place: "関西電力",
        name: "電気料金",
        usage: "258kWh",
        accountHint: "楽天カード",
      });
      return new Response(JSON.stringify({ status: "imported", receiptId: "receipt-usage-1", zaimMoneyId: 456 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    try {
      assert.deepEqual(
        parsed(await assetManagerImportPaymentTool.handler({
          gmailMessageId: "message-usage-1",
          confidence: 0.95,
          date: "2026-08-20",
          amount: 7842,
          place: "関西電力",
          name: "電気料金",
          usage: "258kWh",
          accountHint: "楽天カード",
        }, { sessionId: null })),
        { status: "imported", receiptId: "receipt-usage-1", zaimMoneyId: 456 },
      );
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("usageが32文字を超える場合はエラーにする", async () => {
    assert.deepEqual(
      parsed(await assetManagerImportPaymentTool.handler({ gmailMessageId: "message-usage-2", confidence: 0.9, usage: "a".repeat(33) }, { sessionId: null })),
      { status: "error", reason: "usage は32文字以内の文字列で指定してください" },
    );
  });

  it("usageが文字列でない場合はエラーにする", async () => {
    assert.deepEqual(
      parsed(await assetManagerImportPaymentTool.handler({ gmailMessageId: "message-usage-3", confidence: 0.9, usage: 258 }, { sessionId: null })),
      { status: "error", reason: "usage は32文字以内の文字列で指定してください" },
    );
  });

  it("時刻付きのdateを加工せずそのまま送る", async () => {
    process.env["AIDE_ASSET_MANAGER_URL"] = "https://asset.example.test/";
    process.env["AIDE_ASSET_MANAGER_ZAIM_SYNC_SECRET"] = SECRET;
    const fetchMock = mock.method(globalThis, "fetch", async (_input: string | URL, init?: RequestInit) => {
      assert.deepEqual(JSON.parse(String(init?.body)), {
        source: "gmail",
        gmailMessageId: "message-date-1",
        confidence: 0.9,
        date: "2026-08-20T19:04",
        amount: 1280,
        name: "コーヒー豆",
      });
      return new Response(JSON.stringify({ status: "imported", receiptId: "receipt-date-1", zaimMoneyId: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    try {
      assert.deepEqual(
        parsed(await assetManagerImportPaymentTool.handler({
          gmailMessageId: "message-date-1",
          confidence: 0.9,
          date: "2026-08-20T19:04",
          amount: 1280,
          name: "コーヒー豆",
        }, { sessionId: null })),
        { status: "imported", receiptId: "receipt-date-1", zaimMoneyId: null },
      );
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("dateはAsset Managerが受け付ける書式だけを通す", async () => {
    // 入力スキーマのpatternと実行時の検証が食い違わないよう、同じ値で両方を確かめる。
    const properties = assetManagerImportPaymentTool.inputSchema["properties"] as Record<string, { pattern?: string }>;
    const pattern = new RegExp(properties["date"]!.pattern!);
    // 認証情報が無いときのreasonを目印にして、dateの検証を通り抜けたことを確かめる。
    const secret = process.env["AIDE_ASSET_MANAGER_ZAIM_SYNC_SECRET"];
    delete process.env["AIDE_ASSET_MANAGER_ZAIM_SYNC_SECRET"];

    try {
      for (const value of ["2026-08-20", "2026-08-20T19:04", "2026-08-20T19:04:32", "2026-08-20T19:04Z", "2026-08-20T19:04:32+09:00"]) {
        assert.equal(pattern.test(value), true, `${value} はスキーマで受け付けるはず`);
        assert.deepEqual(
          parsed(await assetManagerImportPaymentTool.handler({ gmailMessageId: "message-date-ok", confidence: 0.9, date: value }, { sessionId: null })),
          { status: "error", reason: "未設定（Asset Manager連携用の認証情報がありません）" },
          `${value} はdateの検証を通り抜けるはず`,
        );
      }

      for (const value of ["2026-08-20 19:04", "2026-08-20T19", "2026/08/20", "2026-08-20T19:04+0900", ""]) {
        assert.equal(pattern.test(value), false, `${value} はスキーマで弾くはず`);
        assert.deepEqual(
          parsed(await assetManagerImportPaymentTool.handler({ gmailMessageId: "message-date-ng", confidence: 0.9, date: value }, { sessionId: null })),
          { status: "error", reason: "date は YYYY-MM-DD または YYYY-MM-DDTHH:mm 形式で指定してください" },
        );
      }
    } finally {
      if (secret === undefined) delete process.env["AIDE_ASSET_MANAGER_ZAIM_SYNC_SECRET"];
      else process.env["AIDE_ASSET_MANAGER_ZAIM_SYNC_SECRET"] = secret;
    }
  });

  it("必須値とconfidenceを実行時にも検証する", async () => {
    assert.deepEqual(parsed(await assetManagerImportPaymentTool.handler({ confidence: 0.9 }, { sessionId: null })), {
      status: "error",
      reason: "gmailMessageId は必須です",
    });
    assert.deepEqual(parsed(await assetManagerImportPaymentTool.handler({ gmailMessageId: "message-4" }, { sessionId: null })), {
      status: "error",
      reason: "confidence は 0 以上 1 以下の数値で必須です",
    });
  });
});
