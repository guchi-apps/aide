import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";

import { printerStatusTool } from "./printer.ts";

/**
 * myroom の内部APIを模したローカルサーバーへ実際にHTTPで叩きに行き、ツールの応答を確かめる。
 * ビューの判定そのもの（鮮度・遷移）は `core/views/printer.test.ts` が持つ。ここは
 * 「通信して、認証を付けて、応答を崩さず返す」ことと、失敗を状態として返すことを見る。
 */

const TOKEN = "test-token-not-a-real-secret";

let server: Server;
let respond: (req: IncomingMessage) => { status: number; body?: unknown };
let seen: { url?: string; authorization?: string } = {};

function freshPrinter(): Record<string, unknown> {
  return {
    online: true,
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
    state: "RUNNING",
    jobName: "benchy.3mf",
    progressPercent: 42,
    remainingMinutes: 35,
    serial: "01P00A000000000",
    accessCode: "12345678",
  };
}

before(async () => {
  server = createServer((req, res) => {
    seen = { url: req.url, authorization: req.headers.authorization };
    const { status, body } = respond(req);
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(body === undefined ? "" : JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  process.env["AIDE_MYROOM_URL"] = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env["AIDE_MYROOM_URL"];
  delete process.env["AIDE_MYROOM_TOKEN"];
});

beforeEach(() => {
  seen = {};
  process.env["AIDE_MYROOM_TOKEN"] = TOKEN;
  respond = () => ({ status: 200, body: { staleThresholdMinutes: 10, printer: freshPrinter() } });
});

async function call(): Promise<Record<string, any>> {
  const result = await printerStatusTool.handler({}, {} as never);
  assert.equal(result.isError, false);
  return JSON.parse(result.content[0]?.text ?? "{}");
}

describe("aide_printer_status", () => {
  it("内部APIへ Bearer で問い合わせ、現在の状態と鮮度を返す", async () => {
    const payload = await call();

    assert.equal(seen.url, "/api/internal/printer-state");
    assert.equal(seen.authorization, `Bearer ${TOKEN}`);
    assert.equal(payload["freshness"], "fresh");
    assert.equal(payload["fresh"], true);
    assert.equal(payload["printer"].state, "printing");
    assert.equal(payload["printer"].progressPercent, 42);
    assert.equal(payload["printer"].remainingMinutes, 35);
  });

  it("応答にトークンも接続情報も含めない", async () => {
    const text = JSON.stringify(await call());

    for (const secret of [TOKEN, "01P00A000000000", "12345678"]) {
      assert.ok(!text.includes(secret), `応答に ${secret} が含まれている`);
    }
  });

  it("更新が止まっていれば、現在の状態を返さず stale と最後の値を分けて返す", async () => {
    respond = () => ({
      status: 200,
      body: {
        staleThresholdMinutes: 10,
        printer: { ...freshPrinter(), updatedAt: new Date(Date.now() - 45 * 60_000).toISOString() },
      },
    });

    const payload = await call();

    assert.equal(payload["freshness"], "stale");
    assert.equal(payload["fresh"], false);
    assert.equal(payload["printer"], null);
    assert.equal(payload["lastKnown"].state, "printing");
    assert.equal(payload["lastKnown"].remainingMinutes, undefined);
  });

  it("myroom が未対応（404）でも例外にせず、取得できなかった状態として返す", async () => {
    respond = () => ({ status: 404 });

    const payload = await call();

    assert.equal(payload["complete"], false);
    assert.equal(payload["fresh"], false);
    assert.equal(payload["printer"], null);
    assert.equal(payload["unavailable"][0].reason, "HTTP 404（内部APIが未実装のバージョン）");
  });

  it("トークンが不一致（401）なら理由を添えて返す。トークンそのものは出さない", async () => {
    respond = () => ({ status: 401 });

    const payload = await call();

    assert.equal(payload["unavailable"][0].reason, "HTTP 401（トークンが一致しない）");
    assert.ok(!JSON.stringify(payload).includes(TOKEN));
  });

  it("トークンが未設定なら、myroom へ問い合わせずに未設定を返す", async () => {
    delete process.env["AIDE_MYROOM_TOKEN"];

    const payload = await call();

    assert.equal(payload["configured"], false);
    assert.equal(payload["complete"], false);
    assert.equal(payload["printer"], null);
    assert.equal(seen.url, undefined);
  });

  it("収集が一度も届いていなければ never を返す", async () => {
    respond = () => ({ status: 200, body: { printer: null } });

    const payload = await call();

    assert.equal(payload["freshness"], "never");
    assert.equal(payload["complete"], true);
    assert.equal(payload["printer"], null);
  });
});
