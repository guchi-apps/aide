import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  type AssignmentState,
  changeMode,
  claim,
  evaluate,
  initialState,
  parseState,
} from "./worker-assignment.ts";

const T0 = Date.parse("2026-11-22T00:00:00Z");
const at = (minutes: number): Date => new Date(T0 + minutes * 60_000);

/** `host` が `from` 分から `to` 分まで2分おきに問い合わせ続けたあとの状態と、各回の判定。 */
function beat(state: AssignmentState, host: "subpc" | "macmini", from: number, to: number) {
  const runs: boolean[] = [];
  for (let m = from; m <= to; m += 2) {
    const result = claim(state, host, at(m));
    state = result.state;
    runs.push(result.decision.run);
  }
  return { state, runs };
}

describe("担当ホストの判定（自動）", () => {
  it("初期状態は主（subpc）が担当し、予備（macmini）は動かさない", () => {
    let state = initialState();
    const sub = claim(state, "subpc", at(0));
    state = sub.state;
    const mac = claim(state, "macmini", at(1));
    assert.equal(sub.decision.run, true);
    assert.equal(mac.decision.run, false);
    assert.equal(mac.decision.owner, "subpc");
  });

  it("両方が動いている間は、ずっと片方だけが動く（二重実行しない）", () => {
    let state = initialState();
    for (let m = 0; m < 180; m += 2) {
      const sub = claim(state, "subpc", at(m));
      const mac = claim(sub.state, "macmini", at(m + 1));
      state = mac.state;
      assert.ok(!(sub.decision.run && mac.decision.run), `${m}分で両方が動いた`);
      assert.equal(sub.decision.run, true);
    }
  });

  it("主が15分途切れたら予備が引き継ぎ、通知を1回だけ受け取る", () => {
    let state = beat(initialState(), "subpc", 0, 10).state;
    // 主の最後は10分。予備が問い合わせ続ける。
    const { state: after, runs } = beat(state, "macmini", 12, 30);
    // 10 + 15 = 25分より前は担当外、以降は担当。
    assert.deepEqual(runs, [12, 14, 16, 18, 20, 22, 24, 26, 28, 30].map((m) => m >= 26));
    assert.equal(after.owner, "macmini");
    assert.equal(after.lastSwitch?.reason, "failover");
    state = after;
    // 通知は切り替えた時点の応答（26分）で渡し済みなので、以後は渡さない。
    assert.equal(claim(state, "macmini", at(32)).decision.notice, null);
  });

  it("切り替えの通知は新しい担当ホストに渡す", () => {
    const state = beat(initialState(), "subpc", 0, 0).state;
    const first = claim(state, "macmini", at(20));
    assert.equal(first.decision.run, true);
    assert.equal(first.decision.notice?.to, "macmini");
    assert.equal(first.decision.notice?.from, "subpc");
  });

  it("主が復旧しても、30分続くまでは予備のまま（起動直後の取り戻し実行は見送る）", () => {
    let state = beat(initialState(), "subpc", 0, 0).state;
    state = beat(state, "macmini", 20, 120).state;
    assert.equal(state.owner, "macmini");

    // 主が122分に復旧。予備も動き続けている。
    for (let m = 122; m < 152; m += 2) {
      const sub = claim(state, "subpc", at(m));
      const mac = claim(sub.state, "macmini", at(m + 1));
      state = mac.state;
      assert.equal(sub.decision.run, false, `${m}分で主が動いた`);
      assert.equal(mac.decision.run, true);
    }
    // 30分続いた（152分）時点で主へ戻る。
    const back = claim(state, "subpc", at(152));
    assert.equal(back.decision.run, true);
    assert.equal(back.state.lastSwitch?.reason, "failback");
    assert.equal(back.decision.notice?.to, "subpc");
    assert.equal(claim(back.state, "macmini", at(153)).decision.run, false);
  });

  it("主の問い合わせが10分を超えて空いたら、続いている時間を数え直す", () => {
    let state = beat(initialState(), "subpc", 0, 0).state;
    state = beat(state, "macmini", 20, 200).state;
    state = beat(state, "subpc", 100, 120).state; // 20分続いた
    state = beat(state, "subpc", 140, 160).state; // 20分空いて再開。続いているのは20分
    assert.equal(evaluate(state, at(160)).owner, "macmini");
  });

  it("どちらも途切れているときは担当を動かさない", () => {
    const state = beat(initialState(), "subpc", 0, 0).state;
    assert.equal(evaluate(state, at(600)).owner, "subpc");
  });
});

describe("担当ホストの判定（固定）", () => {
  it("固定するとその場で移り、止まっていても自動では戻さない", () => {
    let state = beat(initialState(), "subpc", 0, 10).state;
    state = changeMode(state, "macmini", at(11));
    assert.equal(state.owner, "macmini");
    assert.equal(state.lastSwitch?.reason, "manual");
    // Mac mini が止まっても、主が生きていても移さない。
    const sub = claim(state, "subpc", at(120));
    assert.equal(sub.decision.run, false);
    assert.equal(sub.decision.owner, "macmini");
  });

  it("自動へ戻すと、予備が担当のままでも主の継続30分で戻る", () => {
    let state = beat(initialState(), "subpc", 0, 0).state;
    state = changeMode(state, "macmini", at(1));
    state = beat(state, "subpc", 2, 40).state;
    state = changeMode(state, "auto", at(41));
    assert.equal(state.owner, "subpc");
    assert.equal(state.lastSwitch?.reason, "failback");
  });
});

describe("状態の読み込み", () => {
  it("壊れた値・未知の値は初期状態へ倒す", () => {
    assert.deepEqual(parseState(null), initialState());
    assert.deepEqual(parseState({ mode: "x", owner: "vps", hosts: { other: {} } }), initialState());
  });

  it("保存した形を読み戻せる", () => {
    const state = beat(initialState(), "subpc", 0, 0).state;
    const moved = claim(state, "macmini", at(20)).state;
    assert.deepEqual(parseState(JSON.parse(JSON.stringify(moved))), moved);
  });

  it("ファイルへ書き、プロセス内の担当も更新する", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aide-worker-assignment-"));
    process.env["AIDE_WORKER_ASSIGNMENT_PATH"] = join(dir, "state.json");
    const mod = await import("./worker-assignment.ts");
    mod.resetAssignmentForTest();
    await mod.updateAssignment((s) => ({ state: changeMode(s, "macmini", at(0)), result: null }));
    assert.equal(mod.currentOwner(), "macmini");
    const saved = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
    assert.equal(saved.owner, "macmini");
    mod.resetAssignmentForTest();
    delete process.env["AIDE_WORKER_ASSIGNMENT_PATH"];
  });
});
