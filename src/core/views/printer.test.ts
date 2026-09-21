import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_STALE_THRESHOLD_MINUTES, normalizePrinterState, summarizePrinter } from "./printer.ts";
import type { MyRoomPrinter, MyRoomPrinterSnapshot } from "../connectors/myroom/types.ts";

/**
 * `summarizePrinter` は純粋関数なので、テストはここに集中させる。
 * コネクタ（HTTP）側は myroom の実物が契約なので、ここでは触らない（ツール側のテストが通信を見る）。
 */

const NOW = new Date("2026-09-21T03:00:00.000Z");

/** NOW の `minutes` 分前。 */
function ago(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

function printer(overrides: Partial<MyRoomPrinter> = {}): MyRoomPrinter {
  return {
    name: "A1 mini",
    online: true,
    updatedAt: ago(1),
    ageMinutes: 1,
    stale: false,
    state: "printing",
    jobName: "benchy.3mf",
    progressPercent: 42,
    layer: 84,
    totalLayers: 200,
    remainingMinutes: 35,
    nozzleTemperature: 219.6,
    nozzleTargetTemperature: 220,
    bedTemperature: 59.8,
    bedTargetTemperature: 60,
    speedMode: "標準",
    ams: [{ slot: 1, material: "PLA", color: "#FF0000", remainPercent: 80 }],
    errors: [],
    ...overrides,
  };
}

function snapshot(overrides: Partial<MyRoomPrinter> = {}, top: Partial<MyRoomPrinterSnapshot> = {}): MyRoomPrinterSnapshot {
  return { fetchedAt: NOW.toISOString(), staleThresholdMinutes: 10, printer: printer(overrides), ...top };
}

describe("summarizePrinter: 鮮度が新しいとき", () => {
  it("現在の状態をそのまま返し、鮮度も併せて返す", () => {
    const status = summarizePrinter(snapshot(), NOW);

    assert.equal(status.freshness, "fresh");
    assert.equal(status.fresh, true);
    assert.equal(status.ageMinutes, 1);
    assert.equal(status.measuredAt, ago(1));
    assert.equal(status.lastKnown, null);
    assert.ok(status.printer);
    assert.equal(status.printer.state, "printing");
    assert.equal(status.printer.progressPercent, 42);
    assert.equal(status.printer.layer, 84);
    assert.equal(status.printer.totalLayers, 200);
    assert.equal(status.printer.remainingMinutes, 35);
    assert.equal(status.printer.nozzleTemperature, 219.6);
    assert.equal(status.printer.bedTargetTemperature, 60);
    assert.deepEqual(status.printer.ams, [{ slot: 1, material: "PLA", color: "#FF0000", remainPercent: 80 }]);
    assert.equal(status.ok, true);
    assert.deepEqual(status.problems, []);
  });

  it("終了予測時刻を返さない相手には、最終更新＋残り時間から求める", () => {
    const status = summarizePrinter(snapshot({ remainingMinutes: 30 }), NOW);
    assert.equal(status.printer?.estimatedEndAt, new Date(new Date(ago(1)).getTime() + 30 * 60_000).toISOString());
  });

  it("相手が終了予測時刻を返していればそれを使う", () => {
    const status = summarizePrinter(snapshot({ estimatedEndAt: "2026-09-21T13:30:00+09:00" }), NOW);
    assert.equal(status.printer?.estimatedEndAt, "2026-09-21T13:30:00+09:00");
  });

  it("完了・待機では残り時間と終了予測を返さない", () => {
    // 完了後に残り時間0や古い予測が残っていても、「あと何分」に答える材料にしない。
    for (const state of ["finished", "idle", "failed"]) {
      const status = summarizePrinter(snapshot({ state, remainingMinutes: 0, estimatedEndAt: ago(30) }), NOW);
      assert.equal(status.printer?.remainingMinutes, null, state);
      assert.equal(status.printer?.estimatedEndAt, null, state);
    }
  });

  it("エラーがあれば problems に出し、ok にしない", () => {
    const status = summarizePrinter(
      snapshot({ state: "paused", errors: [{ code: "0300_0100", message: "フィラメントが切れた" }] }),
      NOW,
    );

    assert.equal(status.ok, false);
    assert.deepEqual(
      status.problems.map((problem) => problem.severity),
      ["warn", "danger"],
    );
    assert.match(status.problems[1]?.message ?? "", /0300_0100 フィラメントが切れた/);
  });

  it("失敗は danger の問題として出す", () => {
    const status = summarizePrinter(snapshot({ state: "failed" }), NOW);
    assert.equal(status.ok, false);
    assert.equal(status.problems[0]?.severity, "danger");
  });

  it("完了は問題ではない", () => {
    const status = summarizePrinter(snapshot({ state: "finished", progressPercent: 100 }), NOW);
    assert.equal(status.ok, true);
    assert.equal(status.printer?.state, "finished");
  });

  it("myroom がしきい値を返さなければ既定を使う", () => {
    const status = summarizePrinter(snapshot({}, { staleThresholdMinutes: undefined }), NOW);
    assert.equal(status.staleThresholdMinutes, DEFAULT_STALE_THRESHOLD_MINUTES);
  });
});

describe("summarizePrinter: 鮮度が切れているとき、古い値を現在の状態として返さない", () => {
  it("最終更新がしきい値を超えていれば stale。現在の値は空で、最後の値は lastKnown へ分ける", () => {
    const status = summarizePrinter(snapshot({ updatedAt: ago(25), ageMinutes: 25 }), NOW);

    assert.equal(status.freshness, "stale");
    assert.equal(status.fresh, false);
    assert.equal(status.printer, null);
    assert.equal(status.ok, false);
    assert.equal(status.ageMinutes, 25);
    assert.match(status.message, /現在の状態は分からない/);
    assert.ok(status.lastKnown);
    assert.equal(status.lastKnown.asOf, ago(25));
    assert.equal(status.lastKnown.state, "printing");
    assert.equal(status.lastKnown.progressPercent, 42);
  });

  it("lastKnown には残り時間・終了予測・温度を入れない（時間が経てば意味を失う）", () => {
    const status = summarizePrinter(snapshot({ updatedAt: ago(25) }), NOW);
    const keys = Object.keys(status.lastKnown ?? {});

    for (const key of ["remainingMinutes", "estimatedEndAt", "nozzleTemperature", "bedTemperature"]) {
      assert.ok(!keys.includes(key), `lastKnown に ${key} が入っている`);
    }
  });

  it("myroom が stale と判定していれば、AIDEの数え直しが新しくても stale", () => {
    const status = summarizePrinter(snapshot({ stale: true, updatedAt: ago(1) }), NOW);
    assert.equal(status.freshness, "stale");
    assert.equal(status.printer, null);
  });

  it("myroom が stale でないと言っても、AIDEの数え直しが超えていれば stale", () => {
    // 片方の判定・時計のずれが、そのまま「古い値を現在値」にならないよう、どちらかが切れていれば切れている。
    const status = summarizePrinter(snapshot({ stale: false, ageMinutes: 0, updatedAt: ago(30) }), NOW);
    assert.equal(status.freshness, "stale");
    assert.equal(status.printer, null);
  });

  it("しきい値ちょうどまでは新しい", () => {
    assert.equal(summarizePrinter(snapshot({ updatedAt: ago(10) }), NOW).freshness, "fresh");
    assert.equal(summarizePrinter(snapshot({ updatedAt: ago(11) }), NOW).freshness, "stale");
  });

  it("接続できていなければ、最終更新が新しくても disconnected", () => {
    const status = summarizePrinter(snapshot({ online: false, updatedAt: ago(1) }), NOW);

    assert.equal(status.freshness, "disconnected");
    assert.equal(status.printer, null);
    assert.match(status.message, /接続できていない/);
    assert.ok(status.lastKnown);
  });

  it("最終更新の時刻が読めなければ unknown。値は現在の状態としても最後の値としても返さない", () => {
    for (const updatedAt of [null, undefined, "", "きのう"]) {
      const status = summarizePrinter(snapshot({ updatedAt }), NOW);
      assert.equal(status.freshness, "unknown");
      assert.equal(status.printer, null);
      assert.equal(status.lastKnown, null, String(updatedAt));
    }
  });

  it("収集が一度も届いていなければ never", () => {
    const status = summarizePrinter({ fetchedAt: NOW.toISOString(), printer: null }, NOW);

    assert.equal(status.freshness, "never");
    assert.equal(status.printer, null);
    assert.equal(status.lastKnown, null);
    assert.equal(status.ok, false);
    assert.equal(status.complete, true);
  });

  it("鮮度が切れているときは、エラーがあっても現在のエラーとしては問題に出さない", () => {
    const status = summarizePrinter(
      snapshot({ updatedAt: ago(60), errors: [{ code: "1", message: "古いエラー" }] }),
      NOW,
    );

    assert.equal(status.problems.length, 1);
    assert.equal(status.problems[0]?.severity, "warn");
    assert.doesNotMatch(status.problems[0]?.message ?? "", /古いエラー/);
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
    const status = summarizePrinter({ fetchedAt: NOW.toISOString(), printer: leaky, ...{ token: "secret-token" } }, NOW);
    const serialized = JSON.stringify(status);

    for (const secret of ["01P00A000000000", "12345678", "192.168.0.50", "hunter2", "secret-token"]) {
      assert.ok(!serialized.includes(secret), `応答に ${secret} が含まれている`);
    }
  });

  it("長すぎる文字列は切り詰める", () => {
    const status = summarizePrinter(
      snapshot({ jobName: "a".repeat(500), errors: [{ code: "1", message: "b".repeat(500) }] }),
      NOW,
    );

    assert.ok((status.printer?.jobName ?? "").length <= 121);
    assert.ok((status.printer?.errors[0]?.message ?? "").length <= 201);
  });

  it("コードも本文も無いエラーは捨てる", () => {
    const status = summarizePrinter(snapshot({ errors: [{}, { code: null, message: "" }, { code: 5 }] }), NOW);
    assert.deepEqual(status.printer?.errors, [{ code: "5", message: null }]);
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
    assert.equal(normalizePrinterState(null), "unknown");
    assert.equal(normalizePrinterState(3), "unknown");
  });
});
