import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { summarizeRoom } from "./room.ts";
import type { MyRoomSensor, MyRoomSnapshot } from "../connectors/myroom/types.ts";

/**
 * `summarizeRoom` は純粋関数なので、テストはここに集中させる。
 * コネクタ（HTTP）側は myroom の実物が契約なので、ここでは触らない。
 */

const NOW = new Date("2026-08-19T12:00:00.000Z");

function sensor(overrides: Partial<MyRoomSensor> = {}): MyRoomSensor {
  return {
    deviceId: 1,
    name: "リビング",
    measuredAt: "2026-08-19T20:58:00+09:00",
    ageMinutes: 2,
    stale: false,
    temperature: 26.4,
    humidity: 55,
    pressure: 1008.2,
    co2: 620,
    illuminance: 430,
    ...overrides,
  };
}

function snapshot(overrides: Partial<MyRoomSnapshot> = {}): MyRoomSnapshot {
  return {
    fetchedAt: "2026-08-19T21:00:00+09:00",
    staleThresholdMinutes: 15,
    sensors: [sensor()],
    outdoor: { temperature: 31.2, humidity: 68, pressure: 1007.4, observedAt: "2026-08-19T21:00:00+09:00" },
    aircons: [
      {
        acId: 1,
        name: "リビング",
        measuredAt: "2026-08-19T20:59:00+09:00",
        power: "on",
        mode: "cooling",
        targetTemperature: 26,
        roomTemperature: 26.5,
        humidity: 55,
        fanSpeed: "auto",
        online: true,
      },
    ],
    ...overrides,
  };
}

describe("summarizeRoom", () => {
  it("快適な範囲なら問題なしとして返す", () => {
    const status = summarizeRoom(snapshot(), NOW);

    assert.equal(status.configured, true);
    assert.equal(status.complete, true);
    assert.equal(status.ok, true);
    assert.equal(status.severity, "ok");
    assert.deepEqual(status.problems, []);
    assert.equal(status.staleThresholdMinutes, 15);
    assert.equal(status.measuredAt, "2026-08-19T21:00:00+09:00");
  });

  it("室内と屋外の気温差を添える", () => {
    const status = summarizeRoom(snapshot(), NOW);

    // 26.4 − 31.2。小数の誤差を持ち込まないよう1桁へ丸める。
    assert.equal(status.sensors[0]?.outdoorDeltaCelsius, -4.8);
  });

  it("屋外の観測時刻を添える（室温の測定時刻とは別）", () => {
    const status = summarizeRoom(snapshot(), NOW);

    assert.equal(status.outdoor?.observedAt, "2026-08-19T21:00:00+09:00");
  });

  it("屋外の値が無ければ気温差は null にする", () => {
    const status = summarizeRoom(snapshot({ outdoor: null }), NOW);

    assert.equal(status.outdoor, null);
    assert.equal(status.sensors[0]?.outdoorDeltaCelsius, null);
  });

  it("暑い・湿度が高い・CO2が高いを気になる点として挙げる", () => {
    const status = summarizeRoom(
      snapshot({ sensors: [sensor({ temperature: 32.5, humidity: 82, co2: 1600 })] }),
      NOW,
    );

    assert.equal(status.ok, false);
    assert.equal(status.severity, "danger");
    assert.equal(status.problems.length, 3);
    assert.ok(status.problems.every((problem) => problem.severity === "danger"));
    assert.ok(status.problems.some((problem) => problem.message.includes("32.5℃")));
    assert.ok(status.problems.some((problem) => problem.message.includes("1600ppm")));
  });

  it("しきい値を少し超えただけなら warn にとどめる", () => {
    const status = summarizeRoom(snapshot({ sensors: [sensor({ co2: 1100 })] }), NOW);

    assert.equal(status.severity, "warn");
    assert.deepEqual(
      status.problems.map((problem) => problem.severity),
      ["warn"],
    );
  });

  it("受信が止まったセンサーの値は判定に使わない", () => {
    // 止まったセンサーの最後の値（真夏の32℃）を「いまの室温」として報告しない。
    const status = summarizeRoom(
      snapshot({ sensors: [sensor({ stale: true, ageMinutes: 320, temperature: 32.5, co2: 1800 })] }),
      NOW,
    );

    assert.equal(status.problems.length, 1);
    assert.equal(status.problems[0]?.severity, "warn");
    assert.ok(status.problems[0]?.message.includes("320分前"));
    // 値そのものは残す（後から見れば分かるように）。
    assert.equal(status.sensors[0]?.temperature, 32.5);
    // 屋外との気温差は出さない。比べているのが数日前の室温になるため。
    assert.equal(status.sensors[0]?.outdoorDeltaCelsius, null);
    assert.ok(status.note.includes("stale"));
  });

  it("記録が1件も無いセンサーはその旨だけを挙げる", () => {
    const status = summarizeRoom(
      snapshot({
        sensors: [sensor({ measuredAt: null, ageMinutes: null, temperature: null, co2: null })],
      }),
      NOW,
    );

    assert.deepEqual(
      status.problems.map((problem) => problem.message),
      ["リビング の記録がまだ1件も無い"],
    );
  });

  it("エアコンがオフラインなら気になる点に挙げる", () => {
    const status = summarizeRoom(
      snapshot({ aircons: [{ acId: 1, name: "リビング", power: "off", online: false }] }),
      NOW,
    );

    assert.equal(status.ok, false);
    assert.deepEqual(
      status.problems.map((problem) => problem.message),
      ["リビング がオフライン"],
    );
    assert.equal(status.aircons[0]?.online, false);
  });

  it("材料が1件も無ければ ok にしない", () => {
    const status = summarizeRoom({ sensors: [], aircons: [] }, NOW);

    assert.equal(status.ok, false);
    assert.deepEqual(status.problems, []);
    assert.ok(status.note.includes("1件も取得できていない"));
  });

  it("欠けたフィールドは null にして落ちない", () => {
    // 相手が画面都合でフィールドを落としても、AIDE側は状態として返し続ける。
    const status = summarizeRoom({ sensors: [{ deviceId: 3 }] }, NOW);

    const first = status.sensors[0];
    assert.equal(first?.name, "センサー3");
    assert.equal(first?.temperature, null);
    assert.equal(first?.stale, false);
    assert.equal(status.staleThresholdMinutes, null);
  });
});
