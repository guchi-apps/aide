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
  buildStaleAccountsPayload,
  buildZaimSessionRecoveryPayload,
  decideNotification,
  notifyJobFailure,
  notifyJobRecovered,
  notifyStaleAccounts,
  notifyZaimSessionRecovered,
  readState,
  staleAccountsSignature,
  summarizeFailure,
} = await import("./notify.ts");

type FailureRecord = import("./notify.ts").FailureRecord;

const HOUR = 60 * 60 * 1000;

/** 自動再ログインの資格情報が設定されている環境。値そのものは通知に出ない。 */
const WITH_CREDENTIALS = { ZAIM_EMAIL: "someone@example.com", ZAIM_PASSWORD: "dummy" };

/** 資格情報が無い環境（開発機・CI）。 */
const WITHOUT_CREDENTIALS = {};

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
      WITH_CREDENTIALS,
    );
    const viaKeepAlive = summarizeFailure(
      new Error("Command failed: node keep-alive.mjs ZAIM_SESSION_EXPIRED:https://zaim.net/"),
      WITH_CREDENTIALS,
    );
    assert.equal(viaSync.sessionExpiry, "auto-pending");
    assert.equal(viaKeepAlive.sessionExpiry, "auto-pending");
    // 文面は違うが、同じ障害として抑制されてほしい。
    assert.equal(viaSync.signature, viaKeepAlive.signature);
  });

  it("資格情報があれば自動再ログイン待ち、無ければ手動のみとして分類する", () => {
    const raw = new Error("Zaimのログインセッションが失効しています（ZAIM_SESSION_EXPIRED）。");
    assert.equal(summarizeFailure(raw, WITH_CREDENTIALS).sessionExpiry, "auto-pending");
    assert.equal(summarizeFailure(raw, WITHOUT_CREDENTIALS).sessionExpiry, "manual-only");
  });

  it("自動再ログインまで失敗した失効は、資格情報があっても手動が要る側にする", () => {
    const summary = summarizeFailure(
      new Error("Command failed: node keep-alive.mjs ZAIM_SESSION_EXPIRED\nZAIM_AUTO_RELOGIN_FAILED"),
      WITH_CREDENTIALS,
    );
    assert.equal(summary.sessionExpiry, "auto-failed");
    // マーカーは行を分けて足しているので、通知に載る理由の見た目は変わらない。
    assert.equal(summary.reason, "Command failed: node keep-alive.mjs ZAIM_SESSION_EXPIRED");
  });

  it("自動で直る見込みと手動が要る状態で署名を分ける", () => {
    // 同じ署名にすると、悪化したことが6時間の抑制で伝わらなくなる。
    const pending = summarizeFailure(new Error("ZAIM_SESSION_EXPIRED"), WITH_CREDENTIALS);
    const failed = summarizeFailure(
      new Error("ZAIM_SESSION_EXPIRED\nZAIM_AUTO_RELOGIN_FAILED"),
      WITH_CREDENTIALS,
    );
    assert.notEqual(pending.signature, failed.signature);
    assert.equal(decideNotification(
      { signature: pending.signature, firstFailedAt: "2026-08-29T13:32:00.000Z", notifiedAt: "2026-08-29T13:32:00.000Z", count: 1 },
      failed.signature,
      new Date("2026-08-29T14:02:00.000Z"),
    ).shouldNotify, true);
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

  it("自動再ログインまで失敗した失効は、再ログインが要ると分かる形にする", () => {
    const payload = buildFailurePayload({
      job: "zaim-keep-alive",
      summary: summarizeFailure(
        new Error("ZAIM_SESSION_EXPIRED:https://zaim.net/\nZAIM_AUTO_RELOGIN_FAILED"),
        WITH_CREDENTIALS,
      ),
      occurredAt,
      record: recordAt({ count: 4, firstFailedAt: "2026-08-14T00:00:00.000Z" }),
    });
    const [embed] = payload.embeds;
    assert.match(embed.title, /再ログインが必要/);
    // 本文だけ読んでも、手動ログインが要る失敗だと分かること。
    assert.match(embed.description, /自動再ログインも失敗/);
    assert.match(embed.fields.find((f) => f.name === "対応")?.value ?? "", /login\.mjs/);
    assert.match(embed.fields.find((f) => f.name === "エラー")?.value ?? "", /ZAIM_SESSION_EXPIRED/);
    assert.match(embed.fields.find((f) => f.name === "連続失敗")?.value ?? "", /4回目/);
  });

  it("自動で直る見込みがある失効には、手動ログインを促さない", () => {
    // #191。実際には30分ごとの zaim-keep-alive が直すのに「手動でログインし直すまで
    // 失敗し続けます」と送っており、受け取った側が対応の要否を判断できなかった。
    const payload = buildFailurePayload({
      job: "zaim-refresh",
      summary: summarizeFailure(new Error("ZAIM_SESSION_EXPIRED:https://zaim.net/"), WITH_CREDENTIALS),
      occurredAt,
      record: recordAt({ count: 1 }),
    });
    const [embed] = payload.embeds;
    assert.match(embed.title, /自動再ログイン待ち/);
    assert.match(embed.description, /zaim-keep-alive/);
    assert.ok(!embed.description.includes("失敗し続けます"));
    assert.match(embed.fields.find((f) => f.name === "対応")?.value ?? "", /まず待つ/);
  });

  it("資格情報が無い環境の失効は、従来どおり手動ログインを促す", () => {
    const payload = buildFailurePayload({
      job: "zaim-sync",
      summary: summarizeFailure(new Error("ZAIM_SESSION_EXPIRED"), WITHOUT_CREDENTIALS),
      occurredAt,
      record: recordAt({ count: 1 }),
    });
    const [embed] = payload.embeds;
    assert.match(embed.title, /再ログインが必要/);
    assert.match(embed.description, /失敗し続けます/);
    assert.match(embed.fields.find((f) => f.name === "対応")?.value ?? "", /login\.mjs/);
  });

  it("ジョブ横断の回復通知に、失敗していたジョブと確認したジョブが入る", () => {
    const payload = buildZaimSessionRecoveryPayload({
      succeededJob: "zaim-keep-alive",
      recovered: [
        { job: "zaim-refresh", record: recordAt({ firstFailedAt: "2026-08-14T00:00:00.000Z", count: 2 }) },
      ],
      recoveredAt: occurredAt,
    });
    const [embed] = payload.embeds;
    assert.match(embed.title, /セッションが回復/);
    assert.match(embed.description, /zaim-keep-alive/);
    assert.match(
      embed.fields.find((f) => f.name === "失効で失敗していたジョブ")?.value ?? "",
      /zaim-refresh.*2回/,
    );
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

  it("Zaimのジョブが成功したら、他のジョブの失効も回復として1回だけ知らせる", async () => {
    // #191。zaim-refresh（12時間ごと）の失効を zaim-keep-alive（30分ごと）が直しても、
    // ジョブ単位の復旧通知では次の zaim-refresh まで失敗だけが残っていた。
    await notifyJobFailure("zaim-refresh", new Error("ZAIM_SESSION_EXPIRED:https://zaim.net/"));
    assert.equal(received.length, 1);

    await notifyZaimSessionRecovered("zaim-keep-alive");
    assert.equal(received.length, 2);
    assert.equal((await readState())["zaim-refresh"], undefined);

    // 記録を消したので、次に成功しても二重には送らない。
    await notifyZaimSessionRecovered("zaim-keep-alive");
    assert.equal(received.length, 2);
  });

  it("失効以外の失敗は、Zaimのジョブが成功しても消さない", async () => {
    await notifyJobFailure("zaim-refresh", new Error("Zaimの連携口座を1件も読み取れませんでした"));
    await notifyZaimSessionRecovered("zaim-keep-alive");
    // 送るのは失敗の1件だけ。原因が解消したとは限らないため記録も残す。
    assert.equal(received.length, 1);
    assert.ok((await readState())["zaim-refresh"]);
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

  it("ジョブの失敗とは別の記録に残し、互いに消し合わない", async () => {
    await notifyJobFailure("zaim-refresh", new Error("壊れました"));
    await notifyStaleAccounts("zaim-refresh", [{ name: "ゆうちょ銀行", lastUpdatedAt: null }]);
    assert.equal(received.length, 2);

    const state = await readState();
    assert.ok(state["zaim-refresh"]);
    assert.ok(state["zaim-refresh:stale-accounts"]);

    // ジョブ自体が成功しても、口座の更新漏れは解消していない。
    await notifyJobRecovered("zaim-refresh");
    assert.equal((await readState())["zaim-refresh"], undefined);
    assert.ok((await readState())["zaim-refresh:stale-accounts"]);
  });

  it("同じ口座が落ち続けている間は抑制し、直ったら1回だけ知らせる", async () => {
    const accounts = [{ name: "ゆうちょ銀行", lastUpdatedAt: null }];
    await notifyStaleAccounts("zaim-refresh", accounts);
    await notifyStaleAccounts("zaim-refresh", accounts);
    assert.equal(received.length, 1);
    assert.equal((await readState())["zaim-refresh:stale-accounts"]?.count, 2);

    await notifyStaleAccounts("zaim-refresh", []);
    assert.equal(received.length, 2);
    assert.equal((await readState())["zaim-refresh:stale-accounts"], undefined);

    // 全部更新できている日常では何も送らない。
    await notifyStaleAccounts("zaim-refresh", []);
    assert.equal(received.length, 2);
  });

  it("落ちている口座の顔ぶれが変われば抑制しない", async () => {
    await notifyStaleAccounts("zaim-refresh", [{ name: "ゆうちょ銀行", lastUpdatedAt: null }]);
    await notifyStaleAccounts("zaim-refresh", [
      { name: "ゆうちょ銀行", lastUpdatedAt: null },
      { name: "Coincheck", lastUpdatedAt: null },
    ]);
    assert.equal(received.length, 2);
  });

  it("送信できなければ通知済みにしない", async () => {
    respondWith = 500;
    await notifyStaleAccounts("zaim-refresh", [{ name: "ゆうちょ銀行", lastUpdatedAt: null }]);
    assert.equal((await readState())["zaim-refresh:stale-accounts"]?.notifiedAt, null);

    respondWith = 200;
    await notifyStaleAccounts("zaim-refresh", [{ name: "ゆうちょ銀行", lastUpdatedAt: null }]);
    assert.equal(received.length, 2);
  });
});

describe("更新できなかった口座の通知", () => {
  const occurredAt = new Date("2026-08-16T14:20:00.000Z");

  it("顔ぶれが同じなら並び順が違っても同じ署名になる", () => {
    const a = staleAccountsSignature([
      { name: "ゆうちょ銀行", lastUpdatedAt: null },
      { name: "Coincheck", lastUpdatedAt: null },
    ]);
    const b = staleAccountsSignature([
      { name: "Coincheck", lastUpdatedAt: null },
      { name: "ゆうちょ銀行", lastUpdatedAt: null },
    ]);
    assert.equal(a, b);
    // 顔ぶれが変われば署名も変わる（抑制せずに知らせたいため）。
    assert.notEqual(a, staleAccountsSignature([{ name: "Coincheck", lastUpdatedAt: null }]));
  });

  it("口座名と最終更新、AIDE側では直せないことが分かる形にする", () => {
    const payload = buildStaleAccountsPayload({
      job: "zaim-refresh",
      accounts: [
        { name: "ゆうちょ銀行", lastUpdatedAt: "2024-12-18T10:00:00+09:00" },
        { name: "Coincheck", lastUpdatedAt: null },
      ],
      occurredAt,
      record: recordAt({ count: 1 }),
    });
    const [embed] = payload.embeds;

    assert.match(embed.title, /更新できなかった口座/);
    const listed = embed.fields.find((f) => f.name === "更新できなかった口座")?.value ?? "";
    assert.match(listed, /ゆうちょ銀行: 2024-12-18 10:00:00 JST/);
    // 最終更新を読めなかった口座も落とさない。
    assert.match(listed, /Coincheck: 不明/);
    assert.match(embed.fields.find((f) => f.name === "対応")?.value ?? "", /Zaim/);
  });
});
