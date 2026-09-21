import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { ToolResult } from "../types.ts";
import {
  assetManagerAddSubscriptionPriceTool,
  assetManagerCreateSubscriptionTool,
  assetManagerImportPaymentTool,
  assetManagerSubscriptionsTool,
} from "./asset-manager.ts";

const SECRET = "test-asset-manager-secret";

function parsed(result: ToolResult): unknown {
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

  it("HTTPエラーは isError: true にしつつ、レスポンス本文を欠落させない", async () => {
    process.env["AIDE_ASSET_MANAGER_URL"] = "https://asset.example.test";
    process.env["AIDE_ASSET_MANAGER_ZAIM_SYNC_SECRET"] = SECRET;
    const fetchMock = mock.method(globalThis, "fetch", async () =>
      new Response(JSON.stringify({ status: "error", reason: "Unauthorized", receiptId: "kept" }), { status: 401 }),
    );
    try {
      const result = await assetManagerImportPaymentTool.handler({ gmailMessageId: "message-2", confidence: 0.2 }, { sessionId: null });
      assert.equal(result.isError, true);
      assert.deepEqual(parsed(result), {
        status: "error",
        reason: "Unauthorized",
        receiptId: "kept",
        httpStatus: 401,
      });
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("本文のstatusが業務上の値でも、2xx以外なら status: error にそろえる", async () => {
    process.env["AIDE_ASSET_MANAGER_URL"] = "https://asset.example.test";
    process.env["AIDE_ASSET_MANAGER_ZAIM_SYNC_SECRET"] = SECRET;
    const fetchMock = mock.method(globalThis, "fetch", async () =>
      new Response(JSON.stringify({ status: "imported", receiptId: "r-1" }), { status: 500 }),
    );
    try {
      const result = await assetManagerImportPaymentTool.handler({ gmailMessageId: "message-5xx-json", confidence: 0.9 }, { sessionId: null });
      assert.equal(result.isError, true);
      assert.deepEqual(parsed(result), {
        status: "error",
        reason: "Asset ManagerがHTTP 500を返しました",
        receiptId: "r-1",
        httpStatus: 500,
      });
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("5xxのHTMLや空本文でも失敗として返し、本文は載せない", async () => {
    process.env["AIDE_ASSET_MANAGER_URL"] = "https://asset.example.test";
    process.env["AIDE_ASSET_MANAGER_ZAIM_SYNC_SECRET"] = SECRET;
    for (const [status, body] of [[502, "<html><body>Bad Gateway</body></html>"], [503, ""]] as const) {
      const fetchMock = mock.method(globalThis, "fetch", async () => new Response(body, { status }));
      try {
        const result = await assetManagerImportPaymentTool.handler({ gmailMessageId: `message-${status}`, confidence: 0.9 }, { sessionId: null });
        assert.equal(result.isError, true);
        assert.deepEqual(parsed(result), {
          status: "error",
          reason: `Asset ManagerがHTTP ${status}を返しました`,
          httpStatus: status,
        });
      } finally {
        fetchMock.mock.restore();
      }
    }
  });

  it("業務上のduplicateやpendingReviewは2xxで返るので isError にしない", async () => {
    process.env["AIDE_ASSET_MANAGER_URL"] = "https://asset.example.test";
    process.env["AIDE_ASSET_MANAGER_ZAIM_SYNC_SECRET"] = SECRET;
    for (const status of ["duplicate", "pendingReview"]) {
      const fetchMock = mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ status, receiptId: "r-2" }), { status: 200 }));
      try {
        const result = await assetManagerImportPaymentTool.handler({ gmailMessageId: `message-${status}`, confidence: 0.9 }, { sessionId: null });
        assert.equal(result.isError, false);
        assert.deepEqual(parsed(result), { status, receiptId: "r-2" });
      } finally {
        fetchMock.mock.restore();
      }
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

  it("外貨・概算の4項目を加工せずそのまま送る", async () => {
    process.env["AIDE_ASSET_MANAGER_URL"] = "https://asset.example.test/";
    process.env["AIDE_ASSET_MANAGER_ZAIM_SYNC_SECRET"] = SECRET;
    const fetchMock = mock.method(globalThis, "fetch", async (_input: string | URL, init?: RequestInit) => {
      assert.deepEqual(JSON.parse(String(init?.body)), {
        source: "gmail",
        gmailMessageId: "message-fx-1",
        confidence: 0.93,
        date: "2026-09-12",
        amount: 1500,
        name: "クラウドストレージ",
        amountApproximate: true,
        amountNote: "USD 9.99 を 1ドル=150.2円で換算",
        originalAmount: 9.99,
        originalCurrency: "USD",
      });
      return new Response(JSON.stringify({ status: "confirmed", receiptId: "receipt-fx-1", zaimMoneyId: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    try {
      assert.deepEqual(
        parsed(await assetManagerImportPaymentTool.handler({
          gmailMessageId: "message-fx-1",
          confidence: 0.93,
          date: "2026-09-12",
          amount: 1500,
          name: "クラウドストレージ",
          amountApproximate: true,
          amountNote: "USD 9.99 を 1ドル=150.2円で換算",
          originalAmount: 9.99,
          originalCurrency: "USD",
        }, { sessionId: null })),
        { status: "confirmed", receiptId: "receipt-fx-1", zaimMoneyId: null },
      );
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("外貨・概算の項目を省いた呼び出しは、payloadにその項目を含めない", async () => {
    process.env["AIDE_ASSET_MANAGER_URL"] = "https://asset.example.test/";
    process.env["AIDE_ASSET_MANAGER_ZAIM_SYNC_SECRET"] = SECRET;
    const fetchMock = mock.method(globalThis, "fetch", async (_input: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      for (const field of ["amountApproximate", "amountNote", "originalAmount", "originalCurrency"]) {
        assert.equal(field in body, false, `${field} は送られないはず`);
      }
      return new Response(JSON.stringify({ status: "imported" }), { status: 200 });
    });

    try {
      await assetManagerImportPaymentTool.handler({ gmailMessageId: "message-fx-2", confidence: 0.9, amount: 1280 }, { sessionId: null });
      assert.equal(fetchMock.mock.callCount(), 1);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("amountApproximate: false もそのまま送る（省略と区別する）", async () => {
    process.env["AIDE_ASSET_MANAGER_URL"] = "https://asset.example.test/";
    process.env["AIDE_ASSET_MANAGER_ZAIM_SYNC_SECRET"] = SECRET;
    const fetchMock = mock.method(globalThis, "fetch", async (_input: string | URL, init?: RequestInit) => {
      assert.equal((JSON.parse(String(init?.body)) as Record<string, unknown>)["amountApproximate"], false);
      return new Response(JSON.stringify({ status: "imported" }), { status: 200 });
    });

    try {
      await assetManagerImportPaymentTool.handler({ gmailMessageId: "message-fx-3", confidence: 0.9, amountApproximate: false }, { sessionId: null });
      assert.equal(fetchMock.mock.callCount(), 1);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("外貨・概算の項目の不正な値は、送信せずにエラーにする", async () => {
    const fetchMock = mock.method(globalThis, "fetch");
    process.env["AIDE_ASSET_MANAGER_URL"] = "https://asset.example.test/";
    process.env["AIDE_ASSET_MANAGER_ZAIM_SYNC_SECRET"] = SECRET;
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ amountApproximate: "true" }, "amountApproximate は true / false で指定してください"],
      [{ amountNote: 150 }, "amountNote は文字列で指定してください"],
      [{ amountNote: "a".repeat(192) }, "amountNote は 191文字以内で指定してください"],
      [{ originalAmount: "9.99" }, "originalAmount は正の数で指定してください"],
      [{ originalAmount: 0 }, "originalAmount は正の数で指定してください"],
      [{ originalAmount: -1 }, "originalAmount は正の数で指定してください"],
      [{ originalAmount: Infinity }, "originalAmount は正の数で指定してください"],
      [{ originalCurrency: "US" }, "originalCurrency は USD のような3文字の通貨コードで指定してください"],
      [{ originalCurrency: "USDX" }, "originalCurrency は USD のような3文字の通貨コードで指定してください"],
      [{ originalCurrency: "U5D" }, "originalCurrency は USD のような3文字の通貨コードで指定してください"],
      [{ originalCurrency: 840 }, "originalCurrency は USD のような3文字の通貨コードで指定してください"],
    ];

    try {
      for (const [extra, reason] of cases) {
        assert.deepEqual(
          parsed(await assetManagerImportPaymentTool.handler({ gmailMessageId: "message-fx-ng", confidence: 0.9, ...extra }, { sessionId: null })),
          { status: "error", reason },
          JSON.stringify(extra),
        );
      }
      assert.equal(fetchMock.mock.callCount(), 0);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("amountNoteは191文字ちょうどなら通り、小文字の通貨コードも受け付ける", async () => {
    process.env["AIDE_ASSET_MANAGER_URL"] = "https://asset.example.test/";
    process.env["AIDE_ASSET_MANAGER_ZAIM_SYNC_SECRET"] = SECRET;
    const fetchMock = mock.method(globalThis, "fetch", async (_input: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal((body["amountNote"] as string).length, 191);
      // 大文字化はAsset Manager側の役目で、AIDEは値を加工しない。
      assert.equal(body["originalCurrency"], "usd");
      return new Response(JSON.stringify({ status: "imported" }), { status: 200 });
    });

    try {
      await assetManagerImportPaymentTool.handler(
        { gmailMessageId: "message-fx-4", confidence: 0.9, amountNote: "a".repeat(191), originalCurrency: "usd" },
        { sessionId: null },
      );
      assert.equal(fetchMock.mock.callCount(), 1);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("円換算額を丸めずに小数のまま送ると、送信せずにエラーにする", async () => {
    // 9.99 × 150.2 = 1500.498。amountは整数のみなので、換算後は丸めてから渡す（ツール説明で指示している）。
    const fetchMock = mock.method(globalThis, "fetch");
    process.env["AIDE_ASSET_MANAGER_ZAIM_SYNC_SECRET"] = SECRET;
    try {
      assert.deepEqual(
        parsed(await assetManagerImportPaymentTool.handler({
          gmailMessageId: "message-fx-5",
          confidence: 0.9,
          amount: 1500.498,
          originalAmount: 9.99,
          originalCurrency: "USD",
        }, { sessionId: null })),
        { status: "error", reason: "amount は正の整数で指定してください" },
      );
      assert.equal(fetchMock.mock.callCount(), 0);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("ツール説明で、外貨建てなら original* を必ず付けて円換算額を整数へ丸めるよう指示する", () => {
    const description = assetManagerImportPaymentTool.description;
    for (const keyword of ["originalAmount", "originalCurrency", "整数へ丸めた", "amountNote"]) {
      assert.ok(description.includes(keyword), `説明に「${keyword}」があるはず`);
    }
  });

  it("入力スキーマに4項目があり、任意項目のままにする", () => {
    const properties = assetManagerImportPaymentTool.inputSchema["properties"] as Record<string, unknown>;
    for (const field of ["amountApproximate", "amountNote", "originalAmount", "originalCurrency"]) {
      assert.ok(field in properties, `${field} がスキーマにあるはず`);
    }
    assert.deepEqual(assetManagerImportPaymentTool.inputSchema.required, ["gmailMessageId", "confidence"]);
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

describe("asset_manager_subscriptions", () => {
  const SUBSCRIPTIONS = {
    status: "ok",
    asOf: "2026-09-20",
    summary: { monthlyTotalJpy: 6480, yearlyTotalJpy: 77760, activeCount: 1, excludedFromTotal: [], usdJpyRate: 152 },
    subscriptions: [{ id: 3, name: "Adobe Creative Cloud", status: "SCHEDULED_TO_END", amount: 6480, monthlyAmountJpy: 6480 }],
  };

  function useEnv(): void {
    process.env["AIDE_ASSET_MANAGER_URL"] = "https://asset.example.test/";
    process.env["AIDE_ASSET_MANAGER_ZAIM_SYNC_SECRET"] = SECRET;
  }

  it("引数は includeEnded だけの任意項目で、必須は無い", () => {
    assert.deepEqual(Object.keys(assetManagerSubscriptionsTool.inputSchema.properties as object), ["includeEnded"]);
    assert.equal(assetManagerSubscriptionsTool.inputSchema.required, undefined);
    assert.equal(assetManagerSubscriptionsTool.inputSchema.additionalProperties, false);
  });

  it("GETでBearer認証付きで呼び、本文を加工せず返す（既定は解約済みを含めない）", async () => {
    useEnv();
    const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
      assert.equal(input, "https://asset.example.test/api/subscriptions");
      assert.equal(init?.method, "GET");
      assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${SECRET}`);
      assert.equal(init?.body, undefined);
      assert.equal((init?.headers as Record<string, string>)["Content-Type"], undefined);
      return new Response(JSON.stringify(SUBSCRIPTIONS), { status: 200 });
    });
    try {
      const result = await assetManagerSubscriptionsTool.handler({}, { sessionId: null });
      assert.equal(result.isError, false);
      assert.deepEqual(parsed(result), SUBSCRIPTIONS);
      assert.equal(fetchMock.mock.callCount(), 1);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("includeEnded: true のときだけ ?includeEnded=1 を付ける", async () => {
    useEnv();
    const urls: string[] = [];
    const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify(SUBSCRIPTIONS), { status: 200 });
    });
    try {
      await assetManagerSubscriptionsTool.handler({ includeEnded: true }, { sessionId: null });
      await assetManagerSubscriptionsTool.handler({ includeEnded: false }, { sessionId: null });
      assert.deepEqual(urls, [
        "https://asset.example.test/api/subscriptions?includeEnded=1",
        "https://asset.example.test/api/subscriptions",
      ]);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("includeEnded が真偽値でなければ、送信せずにエラーにする", async () => {
    useEnv();
    const fetchMock = mock.method(globalThis, "fetch");
    try {
      for (const value of ["1", 1, "true", null]) {
        const result = await assetManagerSubscriptionsTool.handler({ includeEnded: value }, { sessionId: null });
        assert.deepEqual(parsed(result), { status: "error", reason: "includeEnded は true / false で指定してください" });
      }
      assert.equal(fetchMock.mock.callCount(), 0);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("契約が0件でも、空のまま status: ok で返す（isError にしない）", async () => {
    useEnv();
    const empty = { status: "ok", asOf: "2026-09-20", summary: { activeCount: 0, excludedFromTotal: [] }, subscriptions: [] };
    const fetchMock = mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(empty), { status: 200 }));
    try {
      const result = await assetManagerSubscriptionsTool.handler({}, { sessionId: null });
      assert.equal(result.isError, false);
      assert.deepEqual(parsed(result), empty);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("401・404・5xxは isError: true で、向こうのreasonとhttpStatusを返す", async () => {
    useEnv();
    for (const [status, body, reason] of [
      [401, JSON.stringify({ status: "error", reason: "Unauthorized" }), "Unauthorized"],
      [404, JSON.stringify({ status: "error", reason: "Sync user not found" }), "Sync user not found"],
      [502, "<html>Bad Gateway</html>", "Asset ManagerがHTTP 502を返しました"],
    ] as const) {
      const fetchMock = mock.method(globalThis, "fetch", async () => new Response(body, { status }));
      try {
        const result = await assetManagerSubscriptionsTool.handler({}, { sessionId: null });
        assert.equal(result.isError, true);
        assert.deepEqual(parsed(result), { status: "error", reason, httpStatus: status });
      } finally {
        fetchMock.mock.restore();
      }
    }
  });

  it("secret未設定時は外部へ送信しない", async () => {
    delete process.env["AIDE_ASSET_MANAGER_ZAIM_SYNC_SECRET"];
    const fetchMock = mock.method(globalThis, "fetch");
    try {
      assert.deepEqual(parsed(await assetManagerSubscriptionsTool.handler({}, { sessionId: null })), {
        status: "error",
        reason: "未設定（Asset Manager連携用の認証情報がありません）",
      });
      assert.equal(fetchMock.mock.callCount(), 0);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("接続に失敗したときは、シークレットやURLを載せずに状態として返す", async () => {
    useEnv();
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      throw new Error(`connect ECONNREFUSED https://asset.example.test ${SECRET}`);
    });
    try {
      const result = await assetManagerSubscriptionsTool.handler({}, { sessionId: null });
      assert.equal(result.isError, false);
      assert.deepEqual(parsed(result), { status: "error", reason: "Asset Managerへの接続に失敗しました" });
      assert.ok(!result.content[0]!.text.includes(SECRET));
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("ツール説明で、金額の読み方・解約予定・excludedFromTotal・aide_fixed_costsとの使い分けを示す", () => {
    const description = assetManagerSubscriptionsTool.description;
    for (const keyword of ["monthlyAmountJpy", "amount", "SCHEDULED_TO_END", "ENDED", "excludedFromTotal", "aide_fixed_costs", "includeEnded"]) {
      assert.ok(description.includes(keyword), keyword);
    }
  });
});

describe("asset_manager_create_subscription", () => {
  const PRICE = {
    amount: 1080,
    currency: "JPY",
    billingCycle: "MONTHLY",
    billingInterval: 1,
    billingDay: 15,
    effectiveFrom: "2026-10-01",
  };

  function useEnv(): void {
    process.env["AIDE_ASSET_MANAGER_URL"] = "https://asset.example.test/";
    process.env["AIDE_ASSET_MANAGER_ZAIM_SYNC_SECRET"] = SECRET;
  }

  it("作成に必要な入力をスキーマで必須にする", () => {
    assert.deepEqual(assetManagerCreateSubscriptionTool.inputSchema.required, [
      "name",
      "paymentMethodName",
      "startDate",
      "amount",
      "currency",
      "billingCycle",
      "billingInterval",
      "billingDay",
      "effectiveFrom",
    ]);
    assert.equal(assetManagerCreateSubscriptionTool.inputSchema.additionalProperties, false);
  });

  it("POSTで契約と初回料金をBearer認証付きで送る", async () => {
    useEnv();
    const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
      assert.equal(input, "https://asset.example.test/api/subscriptions");
      assert.equal(init?.method, "POST");
      assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${SECRET}`);
      assert.deepEqual(JSON.parse(String(init?.body)), {
        subscription: {
          name: "Netflix",
          paymentMethodName: "楽天カード",
          startDate: "2026-09-01",
          endDate: null,
          autoRenew: true,
          memo: "家族用",
          labels: ["動画", "家族"],
        },
        price: { ...PRICE, billingMonth: null },
      });
      return new Response(JSON.stringify({ status: "created", subscriptionId: 42 }), { status: 201 });
    });
    try {
      const result = await assetManagerCreateSubscriptionTool.handler({
        name: " Netflix ",
        paymentMethodName: " 楽天カード ",
        startDate: "2026-09-01",
        subscriptionMemo: " 家族用 ",
        labels: [" 動画 ", "家族", ""],
        ...PRICE,
      }, { sessionId: null });
      assert.equal(result.isError, false);
      assert.deepEqual(parsed(result), { status: "created", subscriptionId: 42 });
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("入力不正なら外部へ送信しない", async () => {
    useEnv();
    const fetchMock = mock.method(globalThis, "fetch");
    try {
      const invalidStart = await assetManagerCreateSubscriptionTool.handler({
        name: "Netflix",
        paymentMethodName: "楽天カード",
        startDate: "2026-02-30",
        ...PRICE,
      }, { sessionId: null });
      assert.deepEqual(parsed(invalidStart), { status: "error", reason: "startDate は正しい YYYY-MM-DD 形式で指定してください" });

      const monthlyWithMonth = await assetManagerCreateSubscriptionTool.handler({
        name: "Netflix",
        paymentMethodName: "楽天カード",
        startDate: "2026-09-01",
        billingMonth: 10,
        ...PRICE,
      }, { sessionId: null });
      assert.deepEqual(parsed(monthlyWithMonth), { status: "error", reason: "MONTHLY では billingMonth を指定しないでください" });
      assert.equal(fetchMock.mock.callCount(), 0);
    } finally {
      fetchMock.mock.restore();
    }
  });
});

describe("asset_manager_add_subscription_price", () => {
  const PRICE = {
    amount: 1490,
    currency: "JPY",
    billingCycle: "YEARLY",
    billingInterval: 1,
    billingDay: 10,
    billingMonth: 4,
    effectiveFrom: "2027-04-01",
  };

  function useEnv(): void {
    process.env["AIDE_ASSET_MANAGER_URL"] = "https://asset.example.test";
    process.env["AIDE_ASSET_MANAGER_ZAIM_SYNC_SECRET"] = SECRET;
  }

  it("サブスクIDを含む料金履歴をPOSTする", async () => {
    useEnv();
    const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
      assert.equal(input, "https://asset.example.test/api/subscriptions/42/prices");
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), { price: { ...PRICE, memo: "値上げ" } });
      return new Response(JSON.stringify({ status: "created", subscriptionId: 42, priceId: 99 }), { status: 201 });
    });
    try {
      const result = await assetManagerAddSubscriptionPriceTool.handler({ subscriptionId: 42, memo: " 値上げ ", ...PRICE }, { sessionId: null });
      assert.equal(result.isError, false);
      assert.deepEqual(parsed(result), { status: "created", subscriptionId: 42, priceId: 99 });
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("同じ適用開始日の料金が拒否された場合はHTTPエラーとして返す", async () => {
    useEnv();
    const fetchMock = mock.method(globalThis, "fetch", async () =>
      new Response(JSON.stringify({ status: "error", reason: "同じ適用開始日の料金がすでにあります" }), { status: 409 }),
    );
    try {
      const result = await assetManagerAddSubscriptionPriceTool.handler({ subscriptionId: 42, ...PRICE }, { sessionId: null });
      assert.equal(result.isError, true);
      assert.deepEqual(parsed(result), {
        status: "error",
        reason: "同じ適用開始日の料金がすでにあります",
        httpStatus: 409,
      });
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("サブスクIDと料金を実行時に検証する", async () => {
    useEnv();
    const fetchMock = mock.method(globalThis, "fetch");
    try {
      const badId = await assetManagerAddSubscriptionPriceTool.handler({ subscriptionId: 0, ...PRICE }, { sessionId: null });
      assert.deepEqual(parsed(badId), { status: "error", reason: "subscriptionId は正の整数で指定してください" });
      const badMonth = await assetManagerAddSubscriptionPriceTool.handler({ subscriptionId: 42, ...PRICE, billingMonth: 13 }, { sessionId: null });
      assert.deepEqual(parsed(badMonth), { status: "error", reason: "YEARLY の billingMonth は1〜12の整数で指定してください" });
      assert.equal(fetchMock.mock.callCount(), 0);
    } finally {
      fetchMock.mock.restore();
    }
  });
});
