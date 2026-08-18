import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CachedValue } from "../cache/store.ts";
import type { ZaimSnapshot } from "../connectors/zaim/types.ts";
import type { JobInfo } from "../../worker/jobs/catalog.ts";
import type { JobRecord } from "../../worker/record.ts";
import { formatDuration, readConnectors, summarizeCache, summarizeJob, worst } from "./health.ts";

const JOB: JobInfo = {
  name: "zaim-keep-alive",
  description: "Zaimのセッションを延長する",
  interval: "30分ごと",
  staleAfterMinutes: 90,
};

function run(overrides: Partial<JobRecord> & { ageMinutes?: number }): CachedValue<JobRecord> {
  const { ageMinutes = 5, ...record } = overrides;
  return {
    source: "worker",
    fetchedAt: "2026-08-18T06:00:00.000Z",
    ageMinutes,
    data: {
      job: JOB.name,
      ok: true,
      startedAt: "2026-08-18T05:59:00.000Z",
      seconds: 3.2,
      message: "セッションを延長した",
      host: "subpc",
      ...record,
    },
  };
}

describe("ジョブの判定", () => {
  it("記録が無い状態は異常にしない（まだ一度も動かしていない環境がある）", () => {
    const job = summarizeJob(JOB, null);
    assert.equal(job.severity, "unknown");
    assert.equal(job.lastRun, null);
  });

  it("直近が成功で間隔の内なら正常", () => {
    assert.equal(summarizeJob(JOB, run({ ageMinutes: 30 })).severity, "ok");
  });

  it("成功していても猶予を超えて動いていなければ注意", () => {
    // スケジューラ（systemd timer）が止まっていてもジョブ自身は何も報告しない。
    // 経過時間でしか気づけないため、ここを落とすと止まったことが分からなくなる。
    assert.equal(summarizeJob(JOB, run({ ageMinutes: 91 })).severity, "warn");
  });

  it("直近が失敗なら、どれだけ新しくても異常", () => {
    const job = summarizeJob(JOB, run({ ageMinutes: 1, ok: false, message: "Error: セッションが失効" }));
    assert.equal(job.severity, "danger");
    assert.equal(job.lastRun?.message, "Error: セッションが失効");
  });

  it("実行ホストと所要時間を持ち回る（サブPCとVPSを見分けるため）", () => {
    const job = summarizeJob(JOB, run({ host: "vps", seconds: 12.5 }));
    assert.equal(job.lastRun?.host, "vps");
    assert.equal(job.lastRun?.seconds, 12.5);
  });
});

function snapshot(
  ageMinutes: number,
  onlineAccounts: ZaimSnapshot["onlineAccounts"] = [],
): CachedValue<ZaimSnapshot> {
  return {
    source: "zaim",
    fetchedAt: "2026-08-18T06:00:00.000Z",
    ageMinutes,
    data: {
      balances: [{ name: "〇〇銀行", amount: 1000, lastUpdatedAt: null }],
      holdings: [],
      onlineAccounts,
    },
  };
}

describe("キャッシュの判定", () => {
  const now = new Date("2026-08-18T06:00:00.000Z"); // JST 15:00

  it("一度も巡回していなければ「記録なし」で、異常にはしない", () => {
    const cache = summarizeCache(null, now);
    assert.equal(cache.empty, true);
    assert.equal(cache.severity, "unknown");
    assert.equal(cache.stale, false);
  });

  it("24時間以内なら正常", () => {
    const cache = summarizeCache(snapshot(60), now);
    assert.equal(cache.stale, false);
    assert.equal(cache.severity, "ok");
    assert.equal(cache.balances, 1);
  });

  it("24時間を超えたら注意", () => {
    const cache = summarizeCache(snapshot(60 * 24 + 1), now);
    assert.equal(cache.stale, true);
    assert.equal(cache.severity, "warn");
  });

  it("Zaim側が当日更新していない口座を拾う", () => {
    const cache = summarizeCache(
      snapshot(60, [
        { name: "〇〇銀行", lastUpdatedAt: "2026-08-18T09:00:00+09:00" },
        { name: "△△銀行", lastUpdatedAt: "2024-12-18T10:00:00+09:00" },
      ]),
      now,
    );
    assert.deepEqual(cache.staleAccounts, ["△△銀行"]);
    assert.equal(cache.severity, "warn");
  });

  it("金額そのものは持たず、件数だけを返す", () => {
    const cache = summarizeCache(snapshot(60), now);
    assert.equal("totals" in cache, false);
    assert.equal(JSON.stringify(cache).includes("1000"), false);
  });
});

describe("接続先の設定状況", () => {
  const KEYS = [
    "AIDE_OPS_DASHBOARD_TOKEN",
    "AIDE_GITHUB_TOKEN",
    "AIDE_SUBSCRIPTIONS_TOKEN",
    "ZAIM_EMAIL",
    "ZAIM_PASSWORD",
    "AIDE_SIGNALY_WEBHOOK_URL",
  ];

  /** 環境変数を退避して差し替え、必ず戻す。 */
  function withEnv(values: Record<string, string | undefined>, body: () => void): void {
    const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
    try {
      for (const key of KEYS) delete process.env[key];
      for (const [key, value] of Object.entries(values)) {
        if (value !== undefined) process.env[key] = value;
      }
      body();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it("環境変数が無ければ未設定として出す", () => {
    withEnv({}, () => {
      assert.equal(
        readConnectors().every((connector) => !connector.configured),
        true,
      );
    });
  });

  it("設定済みでも、トークンの値そのものは含めない", () => {
    withEnv({ AIDE_OPS_DASHBOARD_TOKEN: "s3cret-value" }, () => {
      const connectors = readConnectors();
      assert.equal(JSON.stringify(connectors).includes("s3cret-value"), false);
      assert.equal(connectors.find((connector) => connector.key === "ops-dashboard")?.configured, true);
    });
  });

  it("Zaimは画面から疎通確認しない（巡回が重く、外部への実アクセスになる）", () => {
    assert.equal(readConnectors().find((connector) => connector.key === "zaim")?.probeable, false);
  });
});

describe("表示の補助", () => {
  it("悪いほうを採る", () => {
    assert.equal(worst(["ok", "warn", "danger"]), "danger");
    assert.equal(worst(["ok", "warn"]), "warn");
    assert.equal(worst(["ok", "unknown"]), "ok");
    assert.equal(worst([]), "ok");
  });

  it("経過時間を日本語で表す", () => {
    assert.equal(formatDuration(5), "5分");
    assert.equal(formatDuration(90), "1時間30分");
    assert.equal(formatDuration(60 * 26), "1日2時間");
  });
});
