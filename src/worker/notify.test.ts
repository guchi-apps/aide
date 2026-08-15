import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

// 本番の data/ を汚さないよう、記録の置き場を一時ディレクトリへ差し替える。
const STATE_DIR = await mkdtemp(join(tmpdir(), "aide-notify-test-"));
process.env["AIDE_WORKER_STATE_DIR"] = STATE_DIR;

const {
  buildFailurePayload,
  buildRecoveryPayload,
  decideNotification,
  notifyJobFailure,
  notifyJobRecovered,
  readState,
  summarizeFailure,
} = await import("./notify.ts");

type FailureRecord = import("./notify.ts").FailureRecord;

const HOUR = 60 * 60 * 1000;

function recordAt(overrides: Partial<FailureRecord> = {}): FailureRecord {
  return {
    signature: "失敗しました",
    firstFailedAt: "2026-08-14T00:00:00.000Z",
    notifiedAt: "2026-08-14T00:00:00.000Z",
    count: 1,
    ...overrides,
  };
}

describe("失敗理由の整形", () => {
  it("execFile の失敗のように長いメッセージを1行へ切り詰める", () => {
    const stderr = `Command failed: node keep-alive.mjs\n${"x".repeat(2000)}`;
    const summary = summarizeFailure(new Error(stderr));
    assert.ok(!summary.reason.includes("\n"));
    assert.ok(summary.reason.length <= 501);
    assert.equal(summary.reason, "Command failed: node keep-alive.mjs");
  });

  it("execFile の失敗では stderr 側の Error 行を理由に使う", () => {
    // 1行目の「Command failed:」だけでは何が起きたのか分からない。
    const summary = summarizeFailure(
      new Error(
        "Command failed: node scrape.mjs\nError: Timeout 30000ms exceeded\n    at file:///a.mjs:1:1",
      ),
    );
    assert.equal(summary.reason, "Error: Timeout 30000ms exceeded");
  });

  it("500文字を超える1行目は末尾を落とす", () => {
    const summary = summarizeFailure(new Error("y".repeat(600)));
    assert.equal(summary.reason.length, 501);
    assert.ok(summary.reason.endsWith("…"));
  });

  it("Error 以外や空メッセージでも理由が空にならない", () => {
    assert.equal(summarizeFailure("").reason, "（失敗理由を取得できませんでした）");
    assert.equal(summarizeFailure({ toString: () => "壊れた" }).reason, "壊れた");
  });

  it("セッション失効を判別し、署名を理由の文面から独立させる", () => {
    const viaSync = summarizeFailure(
      new Error("Zaimのログインセッションが失効しています（ZAIM_SESSION_EXPIRED）。"),
    );
    const viaKeepAlive = summarizeFailure(
      new Error("Command failed: node keep-alive.mjs ZAIM_SESSION_EXPIRED:https://zaim.net/"),
    );
    assert.equal(viaSync.sessionExpired, true);
    assert.equal(viaKeepAlive.sessionExpired, true);
    // 文面は違うが、同じ障害として抑制されてほしい。
    assert.equal(viaSync.signature, viaKeepAlive.signature);
  });
});

describe("連続失敗の抑制", () => {
  const now = new Date("2026-08-14T12:00:00.000Z");

  it("初回は必ず通知する", () => {
    const { shouldNotify, record } = decideNotification(undefined, "理由A", now);
    assert.equal(shouldNotify, true);
    assert.equal(record.count, 1);
    assert.equal(record.firstFailedAt, now.toISOString());
    // 送信できたかは呼び出し側が決めるため、この時点では未通知のまま。
    assert.equal(record.notifiedAt, null);
  });

  it("同じ理由の6時間以内は抑制し、回数だけ積み上げる", () => {
    const previous = recordAt({
      signature: "理由A",
      notifiedAt: new Date(now.getTime() - 5 * HOUR).toISOString(),
      count: 3,
    });
    const { shouldNotify, record } = decideNotification(previous, "理由A", now);
    assert.equal(shouldNotify, false);
    assert.equal(record.count, 4);
    assert.equal(record.firstFailedAt, previous.firstFailedAt);
  });

  it("6時間を過ぎたら同じ理由でも通知する", () => {
    const previous = recordAt({
      signature: "理由A",
      notifiedAt: new Date(now.getTime() - 6 * HOUR).toISOString(),
      count: 6,
    });
    assert.equal(decideNotification(previous, "理由A", now).shouldNotify, true);
  });

  it("理由が変われば抑制せず、回数と開始時刻をやり直す", () => {
    const previous = recordAt({ signature: "理由A", notifiedAt: now.toISOString(), count: 5 });
    const { shouldNotify, record } = decideNotification(previous, "理由B", now);
    assert.equal(shouldNotify, true);
    assert.equal(record.count, 1);
    assert.equal(record.firstFailedAt, now.toISOString());
  });

  it("前回送信できていなければ抑制しない", () => {
    const previous = recordAt({ signature: "理由A", notifiedAt: null, count: 2 });
    assert.equal(decideNotification(previous, "理由A", now).shouldNotify, true);
  });
});

describe("通知の中身", () => {
  const occurredAt = new Date("2026-08-14T11:07:36.000Z");

  it("失敗通知にジョブ名・発生時刻・理由が入る", () => {
    const payload = buildFailurePayload({
      job: "zaim-sync",
      summary: summarizeFailure(new Error("送信に失敗しました: 500")),
      occurredAt,
      record: recordAt({ count: 1 }),
    });
    const [embed] = payload.embeds;
    assert.equal(embed.title, "❌ [AIDE] zaim-sync 失敗");
    assert.equal(embed.description, "送信に失敗しました: 500");
    assert.equal(embed.fields.find((f) => f.name === "ジョブ")?.value, "`zaim-sync`");
    assert.equal(embed.fields.find((f) => f.name === "発生時刻")?.value, "2026-08-14 20:07:36 JST");
    // 手動対応が要らない失敗に「対応」を出すと、毎回対応が要るように見える。
    assert.equal(
      embed.fields.some((f) => f.name === "対応"),
      false,
    );
  });

  it("セッション失効は再ログインが要ると分かる形にする", () => {
    const payload = buildFailurePayload({
      job: "zaim-keep-alive",
      summary: summarizeFailure(new Error("ZAIM_SESSION_EXPIRED:https://zaim.net/")),
      occurredAt,
      record: recordAt({ count: 4, firstFailedAt: "2026-08-14T00:00:00.000Z" }),
    });
    const [embed] = payload.embeds;
    assert.match(embed.title, /再ログインが必要/);
    // 本文だけ読んでも、手動ログインが要る失敗だと分かること。
    assert.match(embed.description, /ログインセッションが失効/);
    assert.match(embed.fields.find((f) => f.name === "対応")?.value ?? "", /login\.mjs/);
    assert.match(embed.fields.find((f) => f.name === "エラー")?.value ?? "", /ZAIM_SESSION_EXPIRED/);
    assert.match(embed.fields.find((f) => f.name === "連続失敗")?.value ?? "", /4回目/);
  });

  it("復旧通知に失敗していた期間が入る", () => {
    const payload = buildRecoveryPayload({
      job: "zaim-sync",
      record: recordAt({ firstFailedAt: "2026-08-14T00:00:00.000Z", count: 5 }),
      recoveredAt: new Date("2026-08-14T12:00:00.000Z"),
    });
    const [embed] = payload.embeds;
    assert.equal(embed.title, "✅ [AIDE] zaim-sync 復旧");
    assert.match(embed.fields.find((f) => f.name === "失敗していた期間")?.value ?? "", /12時間0分/);
  });
});

describe("送信と記録", () => {
  let server: Server;
  let received: unknown[] = [];
  let respondWith = 200;

  before(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        received.push(JSON.parse(body));
        res.writeHead(respondWith, { "content-type": "application/json" }).end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("ポートを取得できません");
    process.env["AIDE_SIGNALY_WEBHOOK_URL"] = `http://127.0.0.1:${address.port}/webhook/test`;
  });

  after(async () => {
    delete process.env["AIDE_SIGNALY_WEBHOOK_URL"];
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    await rm(STATE_DIR, { recursive: true, force: true });
  });

  beforeEach(async () => {
    received = [];
    respondWith = 200;
    await rm(join(STATE_DIR, "notify-state.json"), { force: true });
  });

  it("失敗を送り、抑制の記録を残す", async () => {
    await notifyJobFailure("zaim-sync", new Error("壊れました"));
    assert.equal(received.length, 1);

    // 同じ理由の2回目は送らないが、回数は積み上がる。
    await notifyJobFailure("zaim-sync", new Error("壊れました"));
    assert.equal(received.length, 1);
    assert.equal((await readState())["zaim-sync"]?.count, 2);
  });

  it("送信できなければ通知済みにしない", async () => {
    respondWith = 500;
    await notifyJobFailure("zaim-sync", new Error("壊れました"));
    assert.equal((await readState())["zaim-sync"]?.notifiedAt, null);

    respondWith = 200;
    await notifyJobFailure("zaim-sync", new Error("壊れました"));
    assert.equal(received.length, 2);
    assert.ok((await readState())["zaim-sync"]?.notifiedAt);
  });

  it("未解決の失敗が無ければ復旧を通知しない", async () => {
    await notifyJobRecovered("zaim-sync");
    assert.equal(received.length, 0);
  });

  it("失敗の後に成功したら復旧を1回だけ通知し、記録を消す", async () => {
    await notifyJobFailure("zaim-sync", new Error("壊れました"));
    await notifyJobRecovered("zaim-sync");
    assert.equal(received.length, 2);
    assert.equal((await readState())["zaim-sync"], undefined);

    await notifyJobRecovered("zaim-sync");
    assert.equal(received.length, 2);
  });

  it("記録にはWebhook URLも取得データも残さない", async () => {
    await notifyJobFailure("zaim-sync", new Error("壊れました"));
    const raw = await readFile(join(STATE_DIR, "notify-state.json"), "utf8");
    assert.ok(!raw.includes("webhook"));
    assert.ok(!raw.includes("127.0.0.1"));
  });

  it("Webhook URLが未設定なら何も送らず記録も作らない", async () => {
    const url = process.env["AIDE_SIGNALY_WEBHOOK_URL"];
    delete process.env["AIDE_SIGNALY_WEBHOOK_URL"];
    try {
      await notifyJobFailure("zaim-sync", new Error("壊れました"));
      assert.equal(received.length, 0);
      assert.deepEqual(await readState(), {});
    } finally {
      process.env["AIDE_SIGNALY_WEBHOOK_URL"] = url;
    }
  });

  it("送信先が落ちていてもジョブ側へ例外を投げない", async () => {
    const url = process.env["AIDE_SIGNALY_WEBHOOK_URL"];
    process.env["AIDE_SIGNALY_WEBHOOK_URL"] = "http://127.0.0.1:1/webhook/test";
    try {
      await notifyJobFailure("zaim-sync", new Error("壊れました"));
      await notifyJobRecovered("zaim-sync");
    } finally {
      process.env["AIDE_SIGNALY_WEBHOOK_URL"] = url;
    }
  });
});
