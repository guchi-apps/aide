import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { summarizeOps } from "./ops.ts";
import type {
  OpsDashboardRaw,
  OpsHostSnapshot,
  OpsHostView,
} from "../connectors/ops-dashboard/types.ts";

/**
 * `summarizeOps` は純粋関数なので、テストはここに集中させる。
 * コネクタ（HTTP）側は ops-dashboard の実物が契約なので、ここでは触らない。
 */

const NOW = new Date("2026-08-15T12:00:00.000Z");

function snapshot(overrides: Partial<OpsHostSnapshot> = {}): OpsHostSnapshot {
  return {
    hostname: "vps",
    cpuPercent: 7,
    memory: { usedBytes: 1, totalBytes: 2, usedPercent: 63 },
    swap: { usedBytes: 1, totalBytes: 2, usedPercent: 4 },
    disks: [{ path: "/", usedBytes: 1, totalBytes: 2, usedPercent: 48 }],
    loadAverage: [0.21, 0.3, 0.4],
    uptimeSeconds: 412 * 3600,
    temperatureCelsius: 45,
    services: [{ name: "aide.service", state: "active", active: true }],
    ...overrides,
  };
}

function host(overrides: Partial<OpsHostView> = {}): OpsHostView {
  return {
    id: "vps",
    label: "VPS",
    ageSeconds: 21,
    online: true,
    latest: snapshot(),
    ...overrides,
  };
}

function raw(overrides: Partial<OpsDashboardRaw> = {}): OpsDashboardRaw {
  return {
    hostStats: { hosts: [host()], offlineAfterSeconds: 300 },
    kumaMonitors: [{ name: "aide", status: "up" }],
    robotMonitors: [{ friendly_name: "portfolio", status: 2 }],
    aiUsage: {
      providers: [
        { name: "Claude", status: "ok", windows: [{ label: "5時間", usedPercent: 38, resetsAt: null }] },
      ],
    },
    githubUsage: {
      status: "ok",
      actions: {
        allowanceMinutes: 200,
        allowanceLimitMinutes: 2000,
        resetsAt: "2026-09-01T00:00:00.000Z",
      },
    },
    onePasswordUsage: {
      status: "ok",
      limits: [{ type: "token", action: "read", limit: 1000, used: 100, remaining: 900 }],
    },
    failures: [],
    ...overrides,
  };
}

const messages = (status: ReturnType<typeof summarizeOps>): string[] =>
  status.problems.map((problem) => problem.message);

describe("すべて正常なとき", () => {
  it("ok / complete を立て、異常を1件も出さない", () => {
    const status = summarizeOps(raw(), NOW);

    assert.equal(status.ok, true);
    assert.equal(status.complete, true);
    assert.equal(status.severity, "ok");
    assert.deepEqual(status.problems, []);
    assert.equal(status.configured, true);
  });

  it("ホストを要約し、履歴や全マウントのような生データは持たせない", () => {
    const [summary] = summarizeOps(raw(), NOW).hosts;

    assert.ok(summary);
    assert.deepEqual(summary.disk, { path: "/", usedPercent: 48 });
    assert.equal(summary.uptimeHours, 412);
    assert.equal(summary.loadAverage1, 0.21);
    assert.deepEqual(summary.failedServices, []);
    assert.equal(Object.hasOwn(summary, "history"), false);
  });

  it("外形監視と残枠をまとめる", () => {
    const status = summarizeOps(raw(), NOW);

    assert.deepEqual(status.monitors, { total: 2, down: [], pending: 0 });
    assert.deepEqual(
      status.quotas.map((quota) => [quota.name, quota.remainingPercent]),
      [
        ["Claude 5時間", 62],
        ["GitHub Actions 無料枠", 90],
        ["1Password トークン1時間枠（読み取り）", 90],
      ],
    );
  });
});

describe("ホストの異常", () => {
  it("オフラインは danger にし、経過時間を添える", () => {
    const status = summarizeOps(
      raw({ hostStats: { hosts: [host({ online: false, ageSeconds: 720 })], offlineAfterSeconds: 300 } }),
      NOW,
    );

    assert.equal(status.ok, false);
    assert.equal(status.severity, "danger");
    assert.deepEqual(messages(status), ["VPS が応答なし（最終受信 12分前）"]);
  });

  it("オフラインのホストでは指標を評価しない（落ちる直前の値を今の異常として報告しない）", () => {
    const dying = host({
      online: false,
      ageSeconds: 600,
      latest: snapshot({ cpuPercent: 100, memory: { usedBytes: 2, totalBytes: 2, usedPercent: 99 } }),
    });
    const status = summarizeOps(raw({ hostStats: { hosts: [dying], offlineAfterSeconds: 300 } }), NOW);

    assert.equal(status.problems.length, 1);
    assert.match(status.problems[0]?.message ?? "", /応答なし/);
  });

  it("しきい値を超えた指標を warn / danger に振り分ける", () => {
    const busy = host({
      latest: snapshot({
        cpuPercent: 88,
        memory: { usedBytes: 2, totalBytes: 2, usedPercent: 96 },
        swap: { usedBytes: 1, totalBytes: 2, usedPercent: 60 },
        disks: [
          { path: "/", usedBytes: 1, totalBytes: 2, usedPercent: 40 },
          { path: "/var", usedBytes: 1, totalBytes: 2, usedPercent: 92 },
        ],
        temperatureCelsius: 78,
      }),
    });
    const status = summarizeOps(raw({ hostStats: { hosts: [busy], offlineAfterSeconds: 300 } }), NOW);

    assert.deepEqual(messages(status), [
      "VPS のCPU使用率が 88%",
      "VPS のメモリ使用率が 96%",
      "VPS のSwap使用率が 60%",
      "VPS の /var が 92%",
      "VPS の温度が 78℃",
    ]);
    // 一番逼迫しているマウントだけを持つ。
    assert.deepEqual(status.hosts[0]?.disk, { path: "/var", usedPercent: 92 });
    assert.equal(status.severity, "danger");
  });

  it("active でない systemd サービスと再起動待ちを拾う", () => {
    const broken = host({
      latest: snapshot({
        services: [
          { name: "aide.service", state: "active", active: true },
          { name: "aide-zaim-sync.service", state: "failed", active: false },
        ],
        maintenance: { rebootRequired: true, securityUpdatesAvailable: 3 },
      }),
    });
    const status = summarizeOps(raw({ hostStats: { hosts: [broken], offlineAfterSeconds: 300 } }), NOW);

    assert.deepEqual(messages(status), [
      "VPS: aide-zaim-sync.service が failed",
      "VPS は再起動待ち",
    ]);
    assert.equal(status.hosts[0]?.securityUpdatesAvailable, 3);
  });

  it("tmux は件数だけにまとめ、24時間以上の放置を警告する", () => {
    const subpc = host({
      id: "subpc",
      label: "サブPC",
      latest: snapshot({
        tmuxSessionTotal: 9,
        tmuxSessions: [
          { name: "aide-issue-31", attached: false, busy: true, lastActivityAt: NOW.toISOString() },
          { name: "old", attached: false, busy: false, lastActivityAt: "2026-08-13T00:00:00.000Z" },
          { name: "unknown", attached: false },
        ],
      }),
    });
    const status = summarizeOps(raw({ hostStats: { hosts: [subpc], offlineAfterSeconds: 300 } }), NOW);

    assert.deepEqual(status.hosts[0]?.tmux, { total: 9, busy: 1, idleOver24h: 1 });
    assert.deepEqual(messages(status), [
      "サブPC に 24時間以上 放置の tmux セッションが 1件",
    ]);
    // セッション名や作業ディレクトリは返さない。
    assert.equal(JSON.stringify(status).includes("aide-issue-31"), false);
  });
});

describe("外形監視", () => {
  it("Down を danger、確認中を warn にする", () => {
    const status = summarizeOps(
      raw({
        kumaMonitors: [
          { name: "aide", status: "down" },
          { name: "asset-manager", status: "pending" },
        ],
        robotMonitors: [{ friendly_name: "portfolio", status: 9 }],
      }),
      NOW,
    );

    assert.deepEqual(status.monitors, {
      total: 3,
      down: ["aide", "portfolio"],
      pending: 1,
    });
    assert.deepEqual(messages(status), [
      "外形監視が停止: aide・portfolio",
      "確認中の外形監視が 1件",
    ]);
  });

  it("メンテナンス中・一時停止中は監視対象に数えない", () => {
    const status = summarizeOps(
      raw({
        kumaMonitors: [{ name: "aide", status: "maintenance" }],
        robotMonitors: [{ friendly_name: "portfolio", status: 0 }],
      }),
      NOW,
    );

    assert.deepEqual(status.monitors, { total: 0, down: [], pending: 0 });
    assert.equal(status.ok, true);
  });
});

describe("残枠", () => {
  it("残り35%以下を warn、15%以下を danger にする", () => {
    const status = summarizeOps(
      raw({
        aiUsage: {
          providers: [
            {
              name: "Claude",
              status: "ok",
              windows: [
                { label: "5時間", usedPercent: 70, resetsAt: null },
                { label: "週間", usedPercent: 92, resetsAt: null, note: "Opus" },
              ],
            },
          ],
        },
        githubUsage: null,
        onePasswordUsage: null,
      }),
      NOW,
    );

    assert.deepEqual(messages(status), [
      "Claude 5時間 の残りが 30%",
      "Claude 週間（Opus） の残りが 8%",
    ]);
    assert.equal(status.severity, "danger");
  });

  it("未設定は異常ではなく unavailable として残し、complete は下げない", () => {
    const status = summarizeOps(
      raw({
        aiUsage: { providers: [{ name: "ChatGPT", status: "unconfigured", windows: [] }] },
        githubUsage: { status: "unconfigured", actions: null },
        onePasswordUsage: { status: "unconfigured", limits: [] },
      }),
      NOW,
    );

    assert.equal(status.ok, true);
    assert.equal(status.complete, true);
    assert.deepEqual(status.unavailable, [
      { source: "ai-usage:ChatGPT", reason: "未設定" },
      { source: "github-usage", reason: "未設定" },
      { source: "onepassword-usage", reason: "未設定" },
    ]);
  });
});

describe("一部のソースを取得できなかったとき", () => {
  it("取れた範囲では ok のまま、complete を落として範囲が限定的だと伝える", () => {
    const status = summarizeOps(
      raw({
        aiUsage: null,
        failures: [{ source: "ai-usage", reason: "HTTP 401" }],
      }),
      NOW,
    );

    assert.equal(status.ok, true);
    assert.equal(status.complete, false);
    assert.equal(status.severity, "warn");
    assert.deepEqual(status.unavailable, [{ source: "ai-usage", reason: "HTTP 401" }]);
    assert.match(status.note, /限定的/);
  });

  it("何も取得できなければホストが空になり、その旨を note に出す", () => {
    const status = summarizeOps(
      {
        hostStats: null,
        kumaMonitors: null,
        robotMonitors: null,
        aiUsage: null,
        githubUsage: null,
        onePasswordUsage: null,
        failures: [{ source: "host-stats", reason: "3000ms 以内に応答しなかった" }],
      },
      NOW,
    );

    assert.deepEqual(status.hosts, []);
    assert.equal(status.monitors, null);
    assert.equal(status.complete, false);
    // 材料が1つも無い状態を「異常なし」と読ませない。
    assert.equal(status.ok, false);
    assert.match(status.note, /1件も取得できていない/);
  });
});
