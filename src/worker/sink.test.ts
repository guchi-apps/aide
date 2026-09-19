import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { CLAUDE_SESSIONS_PUBLISH } from "./jobs/claude-sessions-sync.ts";
import { WEATHER_PUBLISH } from "./jobs/weather-sync.ts";
import { RECORD_PUBLISH } from "./record.ts";
import {
  type PublishOptions,
  describeFetchError,
  isRetriableStatus,
  publish,
  retryDelayMs,
  worstCasePublishMs,
} from "./sink.ts";

const saved = {
  url: process.env["AIDE_INGEST_URL"],
  secret: process.env["AIDE_INGEST_SECRET"],
};

before(() => {
  process.env["AIDE_INGEST_URL"] = "https://aide.example.test/";
  process.env["AIDE_INGEST_SECRET"] = "test-secret";
});

after(() => {
  for (const [name, value] of [
    ["AIDE_INGEST_URL", saved.url],
    ["AIDE_INGEST_SECRET", saved.secret],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** Node の fetch が通信の失敗で投げる形（`TypeError: fetch failed` ＋ cause）。 */
function connectTimeout(): TypeError {
  const cause = Object.assign(new Error("Connect Timeout Error"), {
    code: "UND_ERR_CONNECT_TIMEOUT",
  });
  return new TypeError("fetch failed", { cause });
}

/** 応答を順に返す fetch の代わり。Error を渡した回は投げる。 */
function scriptedFetch(steps: Array<Response | Error>): {
  fetch: typeof fetch;
  calls: () => number;
} {
  let count = 0;
  const fake = (async () => {
    const step = steps[count++];
    if (!step) throw new Error("想定より多く呼ばれた");
    if (step instanceof Error) throw step;
    return step;
  }) as typeof fetch;
  return { fetch: fake, calls: () => count };
}

const noSleep = async (): Promise<void> => {};

describe("publish の再試行", () => {
  it("通信断は再試行し、次で通れば成功にする", async () => {
    const fake = scriptedFetch([connectTimeout(), new Response("{}", { status: 200 })]);
    const waits: number[] = [];
    const result = await publish("zaim-snapshot", "zaim", {}, {}, {
      fetch: fake.fetch,
      sleep: async (ms) => void waits.push(ms),
    });
    assert.equal(fake.calls(), 2);
    assert.deepEqual(waits, [5_000]);
    assert.match(result, /api\/cache\/zaim-snapshot へ送信した（2回目で成功）/);
  });

  it("5xx も再試行する", async () => {
    const fake = scriptedFetch([
      new Response("bad gateway", { status: 502 }),
      new Response("{}", { status: 200 }),
    ]);
    await publish("zaim-snapshot", "zaim", {}, {}, { fetch: fake.fetch, sleep: noSleep });
    assert.equal(fake.calls(), 2);
  });

  it("4xx はやり直しても同じなので即座に失敗する", async () => {
    const fake = scriptedFetch([new Response('{"error":"未知のキー"}', { status: 404 })]);
    await assert.rejects(
      publish("zaim-snapshot", "zaim", {}, {}, { fetch: fake.fetch, sleep: noSleep }),
      /送信に失敗しました（zaim-snapshot）: 404 \{"error":"未知のキー"\}/,
    );
    assert.equal(fake.calls(), 1);
  });

  it("回数を使い切ったら、通信断の中身を含めて失敗する", async () => {
    const fake = scriptedFetch([connectTimeout(), connectTimeout(), connectTimeout()]);
    await assert.rejects(
      publish("zaim-snapshot", "zaim", {}, {}, { fetch: fake.fetch, sleep: noSleep }),
      {
        message: "送信に失敗しました（zaim-snapshot・3回試行）: fetch failed（UND_ERR_CONNECT_TIMEOUT）",
      },
    );
    assert.equal(fake.calls(), 3);
  });

  it("attempts: 1 なら再試行しない", async () => {
    const fake = scriptedFetch([connectTimeout()]);
    await assert.rejects(
      publish("job-zaim-sync", "worker", {}, { attempts: 1 }, { fetch: fake.fetch, sleep: noSleep }),
      { message: "送信に失敗しました（job-zaim-sync）: fetch failed（UND_ERR_CONNECT_TIMEOUT）" },
    );
    assert.equal(fake.calls(), 1);
  });
});

describe("再試行の判断", () => {
  it("5xx と 429 だけを一時的な失敗とみなす", () => {
    assert.equal(isRetriableStatus(500), true);
    assert.equal(isRetriableStatus(503), true);
    assert.equal(isRetriableStatus(429), true);
    assert.equal(isRetriableStatus(401), false);
    assert.equal(isRetriableStatus(404), false);
  });

  it("待ち時間は回数ごとに延び、表を超えたら最後の値を使う", () => {
    assert.equal(retryDelayMs(1), 5_000);
    assert.equal(retryDelayMs(2), 15_000);
    assert.equal(retryDelayMs(3), 15_000);
  });
});

describe("fetch の例外の要約", () => {
  it("cause の code を添える（fetch failed だけでは理由が分からない）", () => {
    assert.equal(describeFetchError(connectTimeout()), "fetch failed（UND_ERR_CONNECT_TIMEOUT）");
  });

  it("code が無ければ cause のメッセージを添える", () => {
    const error = new TypeError("fetch failed", { cause: new Error("other side closed") });
    assert.equal(describeFetchError(error), "fetch failed（other side closed）");
  });

  it("cause が無ければメッセージだけを返す", () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    assert.equal(describeFetchError(timeout), "The operation was aborted due to timeout");
  });
});

/** ユニットファイルの `TimeoutStartSec`（`1min` / `30min` / `90s` の形だけを読む）。 */
async function timeoutStartMs(unit: string): Promise<number> {
  const text = await readFile(new URL(`../../deploy/systemd/${unit}`, import.meta.url), "utf8");
  const match = /^TimeoutStartSec=(\d+)(min|s)?$/m.exec(text);
  assert.ok(match, `${unit} に TimeoutStartSec が無い`);
  return Number(match[1]) * (match[2] === "min" ? 60_000 : 1_000);
}

describe("送信が長引いても systemd に止められない", () => {
  // 止められると通知も記録も残らない。失敗時は本体の送信のあとに記録の送信が続くため、
  // その合計が上限の3/4に収まることを確かめる（残りは取得処理そのものの時間）。
  const cases: Array<[string, PublishOptions]> = [
    ["aide-zaim-sync.service", {}],
    ["aide-zaim-money-sync.service", {}],
    ["aide-weather-sync.service", WEATHER_PUBLISH],
    ["aide-claude-sessions-sync.service", CLAUDE_SESSIONS_PUBLISH],
  ];
  for (const [unit, options] of cases) {
    it(unit, async () => {
      const worst = worstCasePublishMs(options) + worstCasePublishMs(RECORD_PUBLISH);
      assert.ok(worst <= (await timeoutStartMs(unit)) * 0.75, `${unit}: 最悪 ${worst}ms`);
    });
  }

  it("既定は 30秒 × 3回 + 待ち 20秒", () => {
    assert.equal(worstCasePublishMs(), 110_000);
  });
});
