import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_STALE_THRESHOLD_SECONDS, normalizePrinterState, summarizePrinter } from "./printer.ts";
import type { MyRoomPrinter, MyRoomPrinterSnapshot } from "../connectors/myroom/types.ts";

/**
 * `summarizePrinter` は純粋関数なので、テストはここに集中させる。
 * コネクタ（HTTP）側は myroom の実物が契約なので、ここでは触らない（ツール側のテストが通信を見る）。
 *
 * 応答は myroom `backend/bambu.py` の `build_response()` が返す形に揃えている
 * （`connection` が online / printer_offline / collector_stale / no_data の4通り）。
 */

const NOW = new Date("2026-09-21T03:00:00.000Z");

/** NOW の `minutes` 分前。 */
function ago(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

/** myroom `build_snapshot()` の形。印刷中の実機に近い値。 */
function printer(overrides: Partial<MyRoomPrinter> = {}): MyRoomPrinter {
  return {
    state: "printing",
    rawState: "RUNNING",
    job: {
      name: "benchy.3mf",
      progressPercent: 42,
      layer: 84,
      totalLayers: 200,
      remainingMinutes: 35,
      estimatedFinishAt: null,
    },
    nozzle: { temperature: 219.6, target: 220 },
    bed: { temperature: 59.8, target: 60 },
    speed: { level: 2, mode: "standard" },
    ams: {
      connected: true,
      units: [
        {
          id: 0,
          slots: [
            { slot: 0, empty: false, material: "PLA", color: "#FF0000", remainPercent: 80 },
            { slot: 1, empty: true, material: null, color: null, remainPercent: null },
          ],
        },
      ],
    },
    errors: { printError: null, hms: [] },
    ...overrides,
  };
}

/** `connection: "online"`。現在値は `printer` に入り、`lastKnown` は null。 */
function online(overrides: Partial<MyRoomPrinter> = {}, top: Partial<MyRoomPrinterSnapshot> = {}): MyRoomPrinterSnapshot {
  return {
    fetchedAt: NOW.toISOString(),
    staleThresholdSeconds: 180,
    configured: true,
    connection: "online",
    online: true,
    stale: false,
    lastUpdateAt: ago(0.5),
    ageSeconds: 30,
    lastMessageAt: ago(1),
    messageAgeSeconds: 60,
    printer: printer(overrides),
    lastKnown: null,
    ...top,
  };
}

/** `connection: "printer_offline"`。収集は生きているがプリンターに繋がらない。最後の値は `lastKnown`。 */
function printerOffline(overrides: Partial<MyRoomPrinter> = {}): MyRoomPrinterSnapshot {
  return online({}, {
    connection: "printer_offline",
    online: false,
    lastMessageAt: ago(25),
    messageAgeSeconds: 1500,
    printer: null,
    lastKnown: printer(overrides),
  });
}

/** `connection: "collector_stale"`。収集からの受信が途絶えている。最後の値は `lastKnown`。 */
function collectorStale(overrides: Partial<MyRoomPrinter> = {}): MyRoomPrinterSnapshot {
  return online({}, {
    connection: "collector_stale",
    online: false,
    stale: true,
    lastUpdateAt: ago(30),
    ageSeconds: 1800,
    lastMessageAt: ago(31),
    messageAgeSeconds: 1860,
    printer: null,
    lastKnown: printer(overrides),
  });
}

/** `connection: "no_data"`。収集が一度も届いていない。 */
const NO_DATA: MyRoomPrinterSnapshot = {
  fetchedAt: NOW.toISOString(),
  staleThresholdSeconds: 180,
  configured: false,
  connection: "no_data",
  online: false,
  stale: true,
  lastUpdateAt: null,
  ageSeconds: null,
  lastMessageAt: null,
  messageAgeSeconds: null,
  printer: null,
  lastKnown: null,
};

describe("summarizePrinter: online のとき", () => {
  it("現在の状態をそのまま返し、鮮度も併せて返す", () => {
    const status = summarizePrinter(online(), NOW);

    assert.equal(status.freshness, "fresh");
    assert.equal(status.fresh, true);
    assert.equal(status.ageMinutes, 1);
    assert.equal(status.measuredAt, ago(1));
    assert.equal(status.staleThresholdSeconds, 180);
    assert.equal(status.lastKnown, null);
    assert.ok(status.printer);
    assert.equal(status.printer.updatedAt, ago(1));
    assert.equal(status.printer.state, "printing");
    assert.equal(status.printer.jobName, "benchy.3mf");
    assert.equal(status.printer.progressPercent, 42);
    assert.equal(status.printer.layer, 84);
    assert.equal(status.printer.totalLayers, 200);
    assert.equal(status.printer.remainingMinutes, 35);
    assert.equal(status.printer.nozzleTemperature, 219.6);
    assert.equal(status.printer.nozzleTargetTemperature, 220);
    assert.equal(status.printer.bedTemperature, 59.8);
    assert.equal(status.printer.bedTargetTemperature, 60);
    assert.equal(status.printer.speedMode, "standard");
    assert.deepEqual(status.printer.ams, [
      { slot: 0, material: "PLA", color: "#FF0000", remainPercent: 80 },
      { slot: 1, material: null, color: null, remainPercent: null },
    ]);
    assert.equal(status.ok, true);
    assert.deepEqual(status.problems, []);
  });

  it("終了予測時刻を返さない相手には、最後の受信時刻＋残り時間から求める", () => {
    const status = summarizePrinter(online({ job: { remainingMinutes: 30 } }), NOW);
    assert.equal(status.printer?.estimatedEndAt, new Date(new Date(ago(1)).getTime() + 30 * 60_000).toISOString());
  });

  it("相手が終了予測時刻を返していればそれを使う", () => {
    const status = summarizePrinter(
      online({ job: { remainingMinutes: 30, estimatedFinishAt: "2026-09-21T12:30:00+09:00" } }),
      NOW,
    );
    assert.equal(status.printer?.estimatedEndAt, "2026-09-21T12:30:00+09:00");
  });

  it("完了・待機・失敗では残り時間と終了予測を返さない", () => {
    // 完了後に古い予測が残っていても、「あと何分」に答える材料にしない。
    for (const state of ["finished", "idle", "failed"]) {
      const status = summarizePrinter(
        online({ state, job: { remainingMinutes: 5, estimatedFinishAt: ago(30) } }),
        NOW,
      );
      assert.equal(status.printer?.remainingMinutes, null, state);
      assert.equal(status.printer?.estimatedEndAt, null, state);
    }
  });

  it("state が無ければ rawState（gcode_state）から読む", () => {
    const status = summarizePrinter(online({ state: null, rawState: "FINISH" }), NOW);
    assert.equal(status.printer?.state, "finished");
  });

  it("印刷エラーと重大な HMS はエラーとして problems に出し、ok にしない", () => {
    const status = summarizePrinter(
      online({
        state: "paused",
        errors: {
          printError: { code: "0300_4001" },
          hms: [
            { code: "HMS_0700_2000_0002_0001", severity: "serious" },
            { code: "HMS_0300_0100_0001_0007", severity: "fatal" },
          ],
        },
      }),
      NOW,
    );

    assert.equal(status.ok, false);
    assert.deepEqual(status.printer?.errors, [
      { code: "0300_4001", message: "印刷エラー" },
      { code: "HMS_0700_2000_0002_0001", message: "HMS（重大）" },
      { code: "HMS_0300_0100_0001_0007", message: "HMS（致命的）" },
    ]);
    assert.deepEqual(
      status.problems.map((problem) => problem.severity),
      ["warn", "danger", "danger", "danger"],
    );
    assert.match(status.problems[1]?.message ?? "", /0300_4001 印刷エラー/);
  });

  it("情報レベルの HMS（common・info）はエラーとして数えない", () => {
    // myroom の通知と同じ線引き。情報レベルで「エラーが発生」と鳴らさない。
    const status = summarizePrinter(
      online({
        errors: {
          printError: null,
          hms: [
            { code: "HMS_0500_0100_0003_0004", severity: "common" },
            { code: "HMS_0500_0200_0002_0001", severity: "info" },
            { code: "HMS_0500_0200_0002_0002", severity: null },
          ],
        },
      }),
      NOW,
    );

    assert.deepEqual(status.printer?.errors, []);
    assert.equal(status.ok, true);
  });

  it("失敗は danger の問題として出す", () => {
    const status = summarizePrinter(online({ state: "failed" }), NOW);
    assert.equal(status.ok, false);
    assert.equal(status.problems[0]?.severity, "danger");
  });

  it("完了は問題ではない", () => {
    const status = summarizePrinter(online({ state: "finished", job: { progressPercent: 100 } }), NOW);
    assert.equal(status.ok, true);
    assert.equal(status.printer?.state, "finished");
  });

  it("myroom がしきい値を返さなければ既定を使う", () => {
    const status = summarizePrinter(online({}, { staleThresholdSeconds: undefined }), NOW);
    assert.equal(status.staleThresholdSeconds, DEFAULT_STALE_THRESHOLD_SECONDS);
  });

  it("myroom が lastKnown を返していても、online のときは読まない", () => {
    const status = summarizePrinter(online({}, { lastKnown: printer({ state: "finished" }) }), NOW);
    assert.equal(status.printer?.state, "printing");
    assert.equal(status.lastKnown, null);
  });

  it("lastMessageAt が無ければ lastUpdateAt を値の時刻とする", () => {
    const status = summarizePrinter(online({}, { lastMessageAt: null }), NOW);
    assert.equal(status.freshness, "fresh");
    assert.equal(status.measuredAt, ago(0.5));
  });
});

describe("summarizePrinter: online でないとき、古い値を現在の状態として返さない", () => {
  it("printer_offline なら disconnected。現在の値は空で、lastKnown を最後の値として時刻付きで返す", () => {
    const status = summarizePrinter(printerOffline({ state: "finished", job: { progressPercent: 100 } }), NOW);

    assert.equal(status.freshness, "disconnected");
    assert.equal(status.fresh, false);
    assert.equal(status.printer, null);
    assert.equal(status.ok, false);
    assert.equal(status.ageMinutes, 25);
    assert.equal(status.measuredAt, ago(25));
    assert.match(status.message, /接続できていない/);
    assert.match(status.message, /現在の状態は分からない/);
    assert.ok(status.lastKnown);
    assert.equal(status.lastKnown.asOf, ago(25));
    assert.equal(status.lastKnown.state, "finished");
    assert.equal(status.lastKnown.progressPercent, 100);
  });

  it("collector_stale なら stale。現在の値は空で、lastKnown を最後の値として返す", () => {
    const status = summarizePrinter(collectorStale(), NOW);

    assert.equal(status.freshness, "stale");
    assert.equal(status.fresh, false);
    assert.equal(status.printer, null);
    assert.equal(status.ok, false);
    assert.equal(status.ageMinutes, 31);
    assert.match(status.message, /収集が止まっている/);
    assert.equal(status.lastKnown?.asOf, ago(31));
    assert.equal(status.lastKnown?.state, "printing");
    assert.equal(status.lastKnown?.progressPercent, 42);
  });

  it("lastKnown には残り時間・終了予測・温度を入れない（時間が経てば意味を失う）", () => {
    const status = summarizePrinter(printerOffline(), NOW);
    const keys = Object.keys(status.lastKnown ?? {});

    for (const key of ["remainingMinutes", "estimatedEndAt", "nozzleTemperature", "bedTemperature"]) {
      assert.ok(!keys.includes(key), `lastKnown に ${key} が入っている`);
    }
  });

  it("myroom が online と言っても、AIDEの数え直しでしきい値を超えていれば stale", () => {
    // 片方の判定・時計のずれが、そのまま「古い値を現在値」にならないよう、どちらかが切れていれば切れている。
    const status = summarizePrinter(online({}, { lastUpdateAt: ago(10), ageSeconds: 0, lastMessageAt: ago(10) }), NOW);
    assert.equal(status.freshness, "stale");
    assert.equal(status.printer, null);
    assert.equal(status.lastKnown?.state, "printing");
  });

  it("しきい値ちょうどまでは新しい", () => {
    assert.equal(summarizePrinter(online({}, { lastUpdateAt: ago(3) }), NOW).freshness, "fresh");
    assert.equal(summarizePrinter(online({}, { lastUpdateAt: ago(3.1) }), NOW).freshness, "stale");
  });

  it("myroom の stale が立っていれば、connection が online でも stale", () => {
    const status = summarizePrinter(online({}, { stale: true }), NOW);
    assert.equal(status.freshness, "stale");
    assert.equal(status.printer, null);
  });

  it("no_data（収集が一度も届いていない）なら never", () => {
    const status = summarizePrinter(NO_DATA, NOW);

    assert.equal(status.freshness, "never");
    assert.equal(status.printer, null);
    assert.equal(status.lastKnown, null);
    assert.equal(status.ok, false);
    assert.equal(status.complete, true);
  });

  it("接続状態が読めなければ unknown。値は現在の状態としても最後の値としても返さない", () => {
    for (const top of [
      { connection: undefined },
      { connection: "something_new" },
      { online: false },
      { printer: null },
      { lastUpdateAt: null },
      { lastUpdateAt: "きのう" },
    ] satisfies Partial<MyRoomPrinterSnapshot>[]) {
      const status = summarizePrinter(online({}, top), NOW);
      assert.equal(status.freshness, "unknown", JSON.stringify(top));
      assert.equal(status.printer, null, JSON.stringify(top));
      assert.equal(status.lastKnown, null, JSON.stringify(top));
    }
  });

  it("最後の値の時刻が読めなければ、lastKnown も返さない", () => {
    const status = summarizePrinter({ ...printerOffline(), lastMessageAt: null, lastUpdateAt: "きのう" }, NOW);
    assert.equal(status.freshness, "disconnected");
    assert.equal(status.lastKnown, null);
  });

  it("鮮度が切れているときは、エラーがあっても現在のエラーとしては問題に出さない", () => {
    const status = summarizePrinter(
      printerOffline({ errors: { printError: { code: "0300_4001" }, hms: [] } }),
      NOW,
    );

    assert.equal(status.problems.length, 1);
    assert.equal(status.problems[0]?.severity, "warn");
    assert.doesNotMatch(status.problems[0]?.message ?? "", /0300_4001/);
  });
});

describe("summarizePrinter: 認証情報を返さない", () => {
  it("相手が接続情報を余計に返しても、応答へ写さない", () => {
    const leaky = {
      ...printer(),
      serial: "01P00A000000000",
      accessCode: "12345678",
      host: "192.168.0.50",
      password: "hunter2",
    } as MyRoomPrinter;
    const status = summarizePrinter({ ...online(), printer: leaky, ...{ token: "secret-token" } }, NOW);
    const serialized = JSON.stringify(status);

    for (const secret of ["01P00A000000000", "12345678", "192.168.0.50", "hunter2", "secret-token"]) {
      assert.ok(!serialized.includes(secret), `応答に ${secret} が含まれている`);
    }
  });

  it("長すぎる文字列は切り詰める", () => {
    const status = summarizePrinter(
      online({ job: { name: "a".repeat(500) }, errors: { hms: [{ code: "b".repeat(500), severity: "fatal" }] } }),
      NOW,
    );

    assert.ok((status.printer?.jobName ?? "").length <= 121);
    assert.ok((status.printer?.errors[0]?.code ?? "").length <= 41);
  });

  it("コードの無いエラーは捨てる", () => {
    const status = summarizePrinter(
      online({ errors: { printError: { code: "" }, hms: [{ severity: "fatal" }, { code: null, severity: "serious" }] } }),
      NOW,
    );
    assert.deepEqual(status.printer?.errors, []);
  });
});

describe("normalizePrinterState", () => {
  it("Bambu の gcode_state を読み替える", () => {
    assert.equal(normalizePrinterState("IDLE"), "idle");
    assert.equal(normalizePrinterState("PREPARE"), "preparing");
    assert.equal(normalizePrinterState("RUNNING"), "printing");
    assert.equal(normalizePrinterState("PAUSE"), "paused");
    assert.equal(normalizePrinterState("FINISH"), "finished");
    assert.equal(normalizePrinterState("FAILED"), "failed");
  });

  it("日本語の表記も読める", () => {
    assert.equal(normalizePrinterState("待機"), "idle");
    assert.equal(normalizePrinterState("準備"), "preparing");
    assert.equal(normalizePrinterState("印刷中"), "printing");
    assert.equal(normalizePrinterState("一時停止"), "paused");
    assert.equal(normalizePrinterState("完了"), "finished");
    assert.equal(normalizePrinterState("失敗"), "failed");
  });

  it("読めないものは unknown にする（待機と推測しない）", () => {
    assert.equal(normalizePrinterState("SOMETHING_NEW"), "unknown");
    assert.equal(normalizePrinterState("unknown"), "unknown");
    assert.equal(normalizePrinterState(null), "unknown");
    assert.equal(normalizePrinterState(3), "unknown");
  });
});
