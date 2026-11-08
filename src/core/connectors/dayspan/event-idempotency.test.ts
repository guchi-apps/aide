import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EventIdempotencyStore, readEventIdempotencyKey } from "./event-idempotency.ts";

describe("readEventIdempotencyKey", () => {
  it("省略は許す", () => assert.deepEqual(readEventIdempotencyKey(undefined), {}));
  it("短すぎる・非文字列は拒否する", () => {
    assert.ok("error" in readEventIdempotencyKey("abc"));
    assert.ok("error" in readEventIdempotencyKey(12345678));
  });
  it("8文字以上の印字可能ASCIIは通す", () => assert.deepEqual(readEventIdempotencyKey("key-12345"), { key: "key-12345" }));
});

describe("EventIdempotencyStore", () => {
  it("同じキー・同じ内容の再送は作り直さず同じ結果を返す", async () => {
    const store = new EventIdempotencyStore();
    let calls = 0;
    const run = async () => ({ ok: true as const, id: `e${++calls}` });
    const a = await store.run("k1234567", "f", run);
    const b = await store.run("k1234567", "f", run);
    assert.equal(calls, 1);
    assert.deepEqual(a, { replay: false, outcome: { ok: true, id: "e1" } });
    assert.deepEqual(b, { replay: true, outcome: { ok: true, id: "e1" } });
  });

  it("実行中の再送は同じ呼び出しを待つ", async () => {
    const store = new EventIdempotencyStore();
    let calls = 0;
    const run = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return { ok: true as const };
    };
    await Promise.all([store.run("k1234567", "f", run), store.run("k1234567", "f", run)]);
    assert.equal(calls, 1);
  });

  it("同じキーで内容が違えば conflict", async () => {
    const store = new EventIdempotencyStore();
    await store.run("k1234567", "a", async () => ({ ok: true }));
    assert.deepEqual(await store.run("k1234567", "b", async () => ({ ok: true })), { conflict: true });
  });

  it("失敗は覚えず、再送で作り直せる", async () => {
    const store = new EventIdempotencyStore();
    let calls = 0;
    await store.run("k1234567", "f", async () => (++calls, { ok: false }));
    await store.run("k1234567", "f", async () => (++calls, { ok: true }));
    assert.equal(calls, 2);
  });

  it("結果不明の失敗は覚え、同じキーの再送ではPOSTし直さない（#833）", async () => {
    const store = new EventIdempotencyStore();
    let calls = 0;
    const unknown = { ok: false as const, outcomeUnknown: true };
    const a = await store.run("k1234567", "f", async () => (++calls, unknown));
    const b = await store.run("k1234567", "f", async () => (++calls, { ok: true as const }));
    assert.equal(calls, 1);
    assert.deepEqual(a, { replay: false, outcome: unknown });
    assert.deepEqual(b, { replay: true, outcome: unknown });
  });

  it("結果不明の失敗でも、内容を変えれば conflict で、新しいキーなら作れる", async () => {
    const store = new EventIdempotencyStore();
    await store.run("k1234567", "a", async () => ({ ok: false, outcomeUnknown: true }));
    assert.deepEqual(await store.run("k1234567", "b", async () => ({ ok: true })), { conflict: true });
    assert.deepEqual(await store.run("k7654321", "a", async () => ({ ok: true })), { replay: false, outcome: { ok: true } });
  });

  it("上限を超えても、実行中と結果不明の保留は成功済みより後まで落とさない", async () => {
    const store = new EventIdempotencyStore();
    await store.run("unknown-key1", "f", async () => ({ ok: false, outcomeUnknown: true }));
    for (let i = 0; i < 520; i++) await store.run(`ok-key-${i}`, "f", async () => ({ ok: true }));
    let calls = 0;
    const again = await store.run("unknown-key1", "f", async () => (++calls, { ok: true }));
    assert.equal(calls, 0);
    assert.deepEqual(again, { replay: true, outcome: { ok: false, outcomeUnknown: true } });
  });

  it("実行中の同時再送は結果不明を共有する", async () => {
    const store = new EventIdempotencyStore();
    let calls = 0;
    const run = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return { ok: false as const, outcomeUnknown: true };
    };
    const [a, b] = await Promise.all([store.run("k1234567", "f", run), store.run("k1234567", "f", run)]);
    assert.equal(calls, 1);
    assert.deepEqual([a, b].map((r) => "outcome" in r && r.outcome.outcomeUnknown), [true, true]);
  });

  it("期限が切れたら作り直す", async () => {
    let now = 0;
    const store = new EventIdempotencyStore(() => now);
    let calls = 0;
    await store.run("k1234567", "f", async () => (++calls, { ok: true }));
    now += 25 * 60 * 60 * 1000;
    await store.run("k1234567", "f", async () => (++calls, { ok: true }));
    assert.equal(calls, 2);
  });
});
