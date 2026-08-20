import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

// 本番のキャッシュを汚さないよう、読み込み前に置き場を一時ディレクトリへ差し替える。
// パスはモジュール読み込み時に確定するため、import より前に設定する必要がある。
const dir = await mkdtemp(join(tmpdir(), "aide-zaim-master-test-"));
process.env["AIDE_CACHE_DIR"] = dir;
const { readZaimMaster, STALE_AFTER_MINUTES, ZAIM_MASTER_CACHE_KEY } = await import("./zaim-master.ts");
const { fetchZaimMaster } = await import("../connectors/zaim/write.ts");
const { writeCache } = await import("../cache/store.ts");

type FetchZaimMaster = typeof fetchZaimMaster;

/**
 * ここが誤ると、**古いIDのまま支出が登録される**か、登録のたびにZaimのAPIが3本叩かれる。
 * どちらも表からは見えないので、鮮度の分岐だけは押さえておく。
 */

const CREDENTIALS = {
  consumerKey: "ck",
  consumerSecret: "cs",
  accessToken: "at",
  accessTokenSecret: "ats",
};

const MASTER = {
  accounts: [{ id: 1, name: "現金" }],
  categories: [{ id: 101, name: "食費" }],
  genres: [{ id: 10101, name: "食料品", categoryId: 101 }],
};

const CACHE_PATH = join(dir, `${ZAIM_MASTER_CACHE_KEY}.json`);

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(CACHE_PATH, { force: true });
});

/** 呼ばれた回数を数えられる取得関数。 */
function stubFetch(result: Awaited<ReturnType<FetchZaimMaster>>): { fetch: FetchZaimMaster; calls: () => number } {
  let calls = 0;
  return {
    fetch: async () => {
      calls += 1;
      return result;
    },
    calls: () => calls,
  };
}

/** 指定した時刻に取得したことにしてキャッシュを置く。 */
async function seedCache(ageMinutes: number): Promise<void> {
  await writeCache(ZAIM_MASTER_CACHE_KEY, "zaim", MASTER);
  const fetchedAt = new Date(Date.now() - ageMinutes * 60_000).toISOString();
  await writeFile(
    CACHE_PATH,
    JSON.stringify({ source: "zaim", fetchedAt, data: MASTER }, null, 2),
    "utf8",
  );
}

describe("readZaimMaster", () => {
  it("キャッシュが無ければZaimから取得し、次回はキャッシュを使う", async () => {
    const first = stubFetch({ ok: true, master: MASTER });
    const fresh = await readZaimMaster(CREDENTIALS, { fetch: first.fetch });
    assert.equal(fresh.ok, true);
    assert.equal(first.calls(), 1);
    assert.deepEqual(fresh.ok && fresh.master.categories, MASTER.categories);

    // 2回目はZaimを叩かない。ここが効かないと、登録のたびにAPIが3本飛ぶ。
    const second = stubFetch({ ok: true, master: MASTER });
    const cached = await readZaimMaster(CREDENTIALS, { fetch: second.fetch });
    assert.equal(cached.ok, true);
    assert.equal(second.calls(), 0);
  });

  it("鮮度の基準を超えたキャッシュは引き直す", async () => {
    await seedCache(STALE_AFTER_MINUTES + 1);
    const stub = stubFetch({ ok: true, master: MASTER });
    const outcome = await readZaimMaster(CREDENTIALS, { fetch: stub.fetch });
    assert.equal(outcome.ok, true);
    assert.equal(stub.calls(), 1);
    assert.equal(outcome.ok && outcome.master.ageMinutes, 0);
  });

  it("refresh を指定すると鮮度によらず引き直す", async () => {
    await seedCache(1);
    const stub = stubFetch({ ok: true, master: MASTER });
    const outcome = await readZaimMaster(CREDENTIALS, { fetch: stub.fetch, refresh: true });
    assert.equal(outcome.ok, true);
    // Zaimで口座を作った直後に候補へ出せるかがここに掛かっている。
    assert.equal(stub.calls(), 1);
  });

  it("引き直しに失敗しても、掴んでいるキャッシュは捨てずに返す", async () => {
    await seedCache(STALE_AFTER_MINUTES + 10);
    const stub = stubFetch({ ok: false, reason: "HTTP 503（Zaim側の障害）" });
    const outcome = await readZaimMaster(CREDENTIALS, { fetch: stub.fetch });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.reason, "HTTP 503（Zaim側の障害）");
    // Zaimが一時的に落ちているだけで候補が何も出せなくならないこと。
    assert.deepEqual(outcome.ok === false && outcome.master?.accounts, MASTER.accounts);
    assert.equal(outcome.ok === false && outcome.master?.stale, true);
  });

  it("取得できずキャッシュも無ければ master は null になる", async () => {
    const stub = stubFetch({ ok: false, reason: "Zaimへ接続できませんでした" });
    const outcome = await readZaimMaster(CREDENTIALS, { fetch: stub.fetch });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.master, null);
  });
});
