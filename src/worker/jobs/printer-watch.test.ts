import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

// 本番の data/ を汚さないよう、記録の置き場を一時ディレクトリへ差し替える。
const STATE_DIR = await mkdtemp(join(tmpdir(), "aide-printer-watch-test-"));
process.env["AIDE_WORKER_STATE_DIR"] = STATE_DIR;

const { evaluatePrinterStatus, readWatchState } = await import("./printer-watch.ts");
const { summarizePrinter } = await import("../../core/views/printer.ts");

type MyRoomPrinter = import("../../core/connectors/myroom/types.ts").MyRoomPrinter;
type MyRoomPrinterSnapshot = import("../../core/connectors/myroom/types.ts").MyRoomPrinterSnapshot;

const NOW = new Date("2026-09-21T03:00:00.000Z");
const ONE_MINUTE_AGO = new Date(NOW.getTime() - 60_000).toISOString();

function printer(state: string, overrides: Partial<MyRoomPrinter> = {}): MyRoomPrinter {
  return {
    state,
    job: { name: "benchy.3mf", progressPercent: state === "finished" ? 100 : 50 },
    errors: { printError: null, hms: [] },
    ...overrides,
  };
}

/** myroom `build_response()` の online の形。 */
function snapshot(top: Partial<MyRoomPrinterSnapshot> = {}): MyRoomPrinterSnapshot {
  return {
    staleThresholdSeconds: 180,
    configured: true,
    connection: "online",
    online: true,
    stale: false,
    lastUpdateAt: ONE_MINUTE_AGO,
    lastMessageAt: ONE_MINUTE_AGO,
    printer: printer("printing"),
    lastKnown: null,
    ...top,
  };
}

function status(state = "printing", overrides: Partial<MyRoomPrinter> = {}) {
  return summarizePrinter(snapshot({ printer: printer(state, overrides) }), NOW);
}

/** プリンターの電源が切れている（収集は生きている）。最後の値は lastKnown に入る。 */
function offline(lastKnownState: string) {
  return summarizePrinter(
    snapshot({ connection: "printer_offline", online: false, printer: null, lastKnown: printer(lastKnownState) }),
    NOW,
  );
}

let server: Server;
let received: string[] = [];
let respondWith = 204;

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push(body);
      res.statusCode = respondWith;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  process.env["AIDE_SIGNALY_WEBHOOK_URL"] = `http://127.0.0.1:${address.port}/webhook`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(STATE_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  received = [];
  respondWith = 204;
  await rm(join(STATE_DIR, "printer-watch.json"), { force: true });
});

describe("evaluatePrinterStatus", () => {
  it("初回は基準だけ記録し、通知しない", async () => {
    const message = await evaluatePrinterStatus(status("finished"), NOW);

    assert.match(message, /基準を記録/);
    assert.equal(received.length, 0);
    assert.equal((await readWatchState())?.state, "finished");
  });

  it("印刷中→完了で1回だけ通知し、続けて呼んでも重ねて送らない", async () => {
    await evaluatePrinterStatus(status("printing"), NOW);

    const done = await evaluatePrinterStatus(status("finished"), NOW);
    assert.match(done, /1件を通知/);
    assert.equal(received.length, 1);
    assert.match(received[0] ?? "", /印刷が完了/);

    const again = await evaluatePrinterStatus(status("finished"), NOW);
    assert.match(again, /変化なし/);
    assert.equal(received.length, 1);
  });

  it("鮮度が切れている間は何もせず、記録も進めない", async () => {
    await evaluatePrinterStatus(status("printing"), NOW);

    // 電源が切れて更新が止まった。最後の値が「完了」でも遷移を作らない。
    for (const stale of [
      offline("finished"),
      summarizePrinter(
        snapshot({ connection: "collector_stale", online: false, stale: true, printer: null, lastKnown: printer("finished") }),
        NOW,
      ),
      // myroom はまだ online と言っているが、AIDEの数え直しでは収集が止まっている。
      summarizePrinter(snapshot({ lastUpdateAt: new Date(NOW.getTime() - 60 * 60_000).toISOString(), printer: printer("finished") }), NOW),
    ]) {
      const message = await evaluatePrinterStatus(stale, NOW);

      assert.match(message, /判定しない/);
      assert.equal(received.length, 0);
      assert.equal((await readWatchState())?.state, "printing");
    }
  });

  it("切れている間に印刷が終わっていれば、復帰後の新しい値で完了を通知する", async () => {
    await evaluatePrinterStatus(status("printing"), NOW);
    await evaluatePrinterStatus(offline("printing"), NOW);
    assert.equal(received.length, 0);

    await evaluatePrinterStatus(status("finished"), NOW);
    assert.equal(received.length, 1);
  });

  it("収集が一度も届いていない（no_data）ときは何もしない", async () => {
    const never = summarizePrinter({ configured: false, connection: "no_data", printer: null, lastKnown: null }, NOW);
    assert.match(await evaluatePrinterStatus(never, NOW), /判定しない/);
    assert.equal(received.length, 0);
  });

  it("通知を送れなかったときは記録を進めず、例外で失敗させる（次回送り直す）", async () => {
    await evaluatePrinterStatus(status("printing"), NOW);

    respondWith = 500;
    await assert.rejects(evaluatePrinterStatus(status("finished"), NOW), /送れなかった/);
    assert.equal((await readWatchState())?.state, "printing");

    respondWith = 204;
    await evaluatePrinterStatus(status("finished"), NOW);
    assert.equal((await readWatchState())?.state, "finished");
  });

  it("通知先が未設定の環境では、基準も動かさない", async () => {
    const saved = process.env["AIDE_SIGNALY_WEBHOOK_URL"];
    process.env["AIDE_SIGNALY_WEBHOOK_URL"] = "";
    try {
      assert.match(await evaluatePrinterStatus(status(), NOW), /未設定/);
      assert.equal(await readWatchState(), null);
    } finally {
      process.env["AIDE_SIGNALY_WEBHOOK_URL"] = saved;
    }
  });

  it("記録ファイルが壊れていても落ちず、基準を作り直す", async () => {
    await writeFile(join(STATE_DIR, "printer-watch.json"), "{壊れた", "utf8");

    const message = await evaluatePrinterStatus(status(), NOW);

    assert.match(message, /基準を記録/);
    assert.equal(received.length, 0);
  });

  it("記録ファイルには状態とエラーの署名だけを残す（取得した値・ジョブ名は残さない）", async () => {
    await evaluatePrinterStatus(status("printing", { job: { name: "secret-model.3mf" } }), NOW);

    const raw = await readFile(join(STATE_DIR, "printer-watch.json"), "utf8");
    assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ["errorSignature", "observedAt", "state"]);
    assert.ok(!raw.includes("secret-model"));
  });

  it("通知本文にジョブ名・進捗は載るが、接続情報は載らない", async () => {
    await evaluatePrinterStatus(status("printing"), NOW);
    const leaky = { serial: "01P00A000000000", accessCode: "12345678", host: "192.168.0.50" };
    await evaluatePrinterStatus(
      status("finished", leaky as Partial<MyRoomPrinter>),
      NOW,
    );

    assert.equal(received.length, 1);
    assert.match(received[0] ?? "", /benchy\.3mf/);
    for (const secret of Object.values(leaky)) {
      assert.ok(!(received[0] ?? "").includes(secret), `通知本文に ${secret} が含まれている`);
    }
  });
});
