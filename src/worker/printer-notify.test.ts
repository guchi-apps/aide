import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PrinterReading } from "../core/views/printer.ts";
import { buildPrinterPayload, decidePrinterEvents, type PrinterEvent, type PrinterWatchState } from "./printer-notify.ts";

function reading(overrides: Partial<PrinterReading> = {}): PrinterReading {
  return {
    updatedAt: "2026-09-21T03:00:00.000Z",
    state: "printing",
    jobName: "benchy.3mf",
    progressPercent: 50,
    layer: 100,
    totalLayers: 200,
    remainingMinutes: 30,
    estimatedEndAt: null,
    nozzleTemperature: 220,
    nozzleTargetTemperature: 220,
    bedTemperature: 60,
    bedTargetTemperature: 60,
    speedMode: null,
    ams: [],
    errors: [],
    ...overrides,
  };
}

function watch(overrides: Partial<PrinterWatchState> = {}): PrinterWatchState {
  return { state: "printing", errorSignature: "", observedAt: "2026-09-21T02:58:00.000Z", ...overrides };
}

describe("decidePrinterEvents", () => {
  it("初回は通知せず、基準だけ作る", () => {
    // 昨日終わった印刷の「完了」を、導入した瞬間に送らない。
    const { events, next } = decidePrinterEvents(null, reading({ state: "finished" }));

    assert.deepEqual(events, []);
    assert.equal(next?.state, "finished");
  });

  it("印刷中→完了で完了を1回通知する", () => {
    const { events, next } = decidePrinterEvents(
      watch(),
      reading({ state: "finished", progressPercent: 100, layer: 200 }),
    );

    assert.deepEqual(events.map((event) => event.kind), ["finished"]);
    assert.equal(events[0]?.jobName, "benchy.3mf");
    assert.equal(next?.state, "finished");
  });

  it("完了のまま続く間は通知しない", () => {
    const { events } = decidePrinterEvents(watch({ state: "finished" }), reading({ state: "finished" }));
    assert.deepEqual(events, []);
  });

  it("次の印刷を挟めば、同じジョブ名でもまた完了を通知する", () => {
    const started = decidePrinterEvents(watch({ state: "finished" }), reading({ state: "printing" }));
    assert.deepEqual(started.events, []);

    const finished = decidePrinterEvents(started.next, reading({ state: "finished" }));
    assert.deepEqual(finished.events.map((event) => event.kind), ["finished"]);
  });

  it("印刷中→失敗（中止を含む）で停止を通知する", () => {
    const { events } = decidePrinterEvents(watch(), reading({ state: "failed", progressPercent: 30 }));
    assert.deepEqual(events.map((event) => event.kind), ["failed"]);
  });

  it("失敗にエラーが伴うときは、停止1件にエラーを載せる（二重に送らない）", () => {
    const { events } = decidePrinterEvents(
      watch(),
      reading({ state: "failed", errors: [{ code: "0500_4001", message: "ノズルが詰まった" }] }),
    );

    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, "failed");
    assert.equal(events[0]?.errors[0]?.code, "0500_4001");
  });

  it("新しいエラーが現れたら1回通知し、続いている間は通知しない", () => {
    const errors = [{ code: "0300_0100", message: "フィラメントが切れた" }];

    const first = decidePrinterEvents(watch(), reading({ state: "paused", errors }));
    assert.deepEqual(first.events.map((event) => event.kind), ["error"]);
    assert.equal(first.next?.errorSignature, "0300_0100");

    const again = decidePrinterEvents(first.next, reading({ state: "paused", errors }));
    assert.deepEqual(again.events, []);
  });

  it("エラーが消えたあとに同じエラーが起きれば、また通知する", () => {
    const errors = [{ code: "0300_0100", message: "フィラメントが切れた" }];
    const raised = decidePrinterEvents(watch(), reading({ state: "paused", errors }));
    const cleared = decidePrinterEvents(raised.next, reading({ state: "printing", errors: [] }));
    assert.deepEqual(cleared.events, []);
    assert.equal(cleared.next?.errorSignature, "");

    const again = decidePrinterEvents(cleared.next, reading({ state: "paused", errors }));
    assert.deepEqual(again.events.map((event) => event.kind), ["error"]);
  });

  it("エラーの顔ぶれが変わったときは、続いていても通知する", () => {
    const { events } = decidePrinterEvents(
      watch({ state: "paused", errorSignature: "A" }),
      reading({ state: "paused", errors: [{ code: "B", message: "別のエラー" }] }),
    );
    assert.deepEqual(events.map((event) => event.kind), ["error"]);
  });

  it("エラーを伴わない一時停止は通知しない（自分で止めた場合も鳴らさない）", () => {
    const { events } = decidePrinterEvents(watch(), reading({ state: "paused" }));
    assert.deepEqual(events, []);
  });

  it("印刷の開始・待機への遷移は通知しない", () => {
    assert.deepEqual(decidePrinterEvents(watch({ state: "idle" }), reading({ state: "preparing" })).events, []);
    assert.deepEqual(decidePrinterEvents(watch({ state: "finished" }), reading({ state: "idle" })).events, []);
  });

  it("状態が読めない値は無視し、基準も進めない", () => {
    const previous = watch({ state: "printing" });
    const { events, next } = decidePrinterEvents(previous, reading({ state: "unknown" }));

    assert.deepEqual(events, []);
    assert.equal(next, previous);
    // 続けて読めた完了は、読めない値を挟んでも印刷中との比較で通知される。
    assert.deepEqual(
      decidePrinterEvents(next, reading({ state: "finished" })).events.map((event) => event.kind),
      ["finished"],
    );
  });

  it("読めない値だけで基準を作らない", () => {
    assert.equal(decidePrinterEvents(null, reading({ state: "unknown" })).next, null);
  });
});

describe("buildPrinterPayload", () => {
  const DETECTED = new Date("2026-09-21T03:05:00.000Z");

  function event(overrides: Partial<PrinterEvent> = {}): PrinterEvent {
    return {
      kind: "finished",
      jobName: "benchy.3mf",
      progressPercent: 100,
      layer: 200,
      totalLayers: 200,
      errors: [],
      updatedAt: "2026-09-21T03:00:00.000Z",
      ...overrides,
    };
  }

  function fields(payload: ReturnType<typeof buildPrinterPayload>): Record<string, string> {
    return Object.fromEntries((payload.embeds[0]?.fields ?? []).map((field) => [field.name, field.value]));
  }

  it("完了はジョブ名・進捗・最終更新・検知時刻を載せる", () => {
    const payload = buildPrinterPayload(event(), DETECTED);

    assert.match(payload.embeds[0]?.title ?? "", /印刷が完了/);
    const values = fields(payload);
    assert.equal(values["ジョブ"], "benchy.3mf");
    assert.equal(values["進捗"], "100% / 200/200層");
    assert.match(values["プリンターの最終更新"] ?? "", /2026-09-21 12:00:00 JST/);
    assert.match(values["検知時刻"] ?? "", /2026-09-21 12:05:00 JST/);
    assert.equal(values["エラー"], undefined);
  });

  it("停止とエラーは赤で、エラーの内容を載せる", () => {
    for (const kind of ["failed", "error"] as const) {
      const payload = buildPrinterPayload(
        event({ kind, errors: [{ code: "0300_0100", message: "フィラメントが切れた" }] }),
        DETECTED,
      );
      assert.equal(payload.embeds[0]?.color, 15548997, kind);
      assert.equal(fields(payload)["エラー"], "0300_0100 フィラメントが切れた", kind);
    }
  });

  it("完了は緑で、停止とは色も文面も違う", () => {
    const done = buildPrinterPayload(event(), DETECTED).embeds[0];
    const stopped = buildPrinterPayload(event({ kind: "failed" }), DETECTED).embeds[0];

    assert.equal(done?.color, 5763719);
    assert.notEqual(done?.title, stopped?.title);
  });

  it("ジョブ名が無いときは、取得できなかったと明示する", () => {
    assert.match(fields(buildPrinterPayload(event({ jobName: null }), DETECTED))["ジョブ"] ?? "", /取得できなかった/);
  });

  it("エラーが多くてもフィールドの上限に収める", () => {
    const errors = Array.from({ length: 10 }, (_, index) => ({ code: String(index), message: "x".repeat(200) }));
    const value = fields(buildPrinterPayload(event({ kind: "error", errors }), DETECTED))["エラー"] ?? "";
    assert.ok(value.length <= 1024);
  });
});
