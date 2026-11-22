import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { askServer, buildSwitchPayload, workerHostName } from "./server-assignment.ts";

function respond(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

afterEach(() => {
  delete process.env["AIDE_INGEST_URL"];
  delete process.env["AIDE_INGEST_SECRET"];
  delete process.env["AIDE_WORKER_HOST"];
});

describe("askServer", () => {
  it("送信先が無い（開発機）なら問い合わせずに local", async () => {
    let called = false;
    const outcome = await askServer("weather-sync", {
      fetch: (async () => {
        called = true;
        return new Response("{}");
      }) as typeof fetch,
    });
    assert.deepEqual(outcome, { kind: "local" });
    assert.equal(called, false);
  });

  it("サーバーの判定をそのまま返し、ホスト名とジョブ名を送る", async () => {
    process.env["AIDE_INGEST_URL"] = "https://aide.example/";
    process.env["AIDE_INGEST_SECRET"] = "s";
    let sent: { url: string; body: unknown } | null = null;
    const outcome = await askServer("zaim-sync", {
      host: "macmini",
      fetch: (async (url: string, init: RequestInit) => {
        sent = { url, body: JSON.parse(String(init.body)) };
        return new Response(JSON.stringify({ run: false, owner: "subpc", mode: "auto", notice: null }));
      }) as unknown as typeof fetch,
    });
    assert.deepEqual(sent, { url: "https://aide.example/api/worker/claim", body: { host: "macmini", job: "zaim-sync" } });
    assert.equal(outcome.kind, "decided");
    assert.equal(outcome.kind === "decided" && outcome.response.run, false);
  });

  it("届かない・4xx・応答の形が違うときは failed（動かさない側）", async () => {
    process.env["AIDE_INGEST_URL"] = "https://aide.example";
    process.env["AIDE_INGEST_SECRET"] = "s";
    const down = (async () => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    }) as typeof fetch;
    assert.equal((await askServer("weather-sync", { fetch: down })).kind, "failed");
    assert.equal((await askServer("weather-sync", { fetch: respond(401, { error: "x" }) })).kind, "failed");
    assert.equal((await askServer("weather-sync", { fetch: respond(200, { ok: true }) })).kind, "failed");
  });

  it("404は口の無い版のサーバー（リリース前）として unsupported（従来どおり動かす）", async () => {
    process.env["AIDE_INGEST_URL"] = "https://aide.example";
    process.env["AIDE_INGEST_SECRET"] = "s";
    assert.equal((await askServer("weather-sync", { fetch: respond(404, { error: "not found" }) })).kind, "unsupported");
  });

  it("送信先があってシークレットが無いのは設定ミスとして failed", async () => {
    process.env["AIDE_INGEST_URL"] = "https://aide.example";
    assert.equal((await askServer("weather-sync")).kind, "failed");
  });
});

describe("workerHostName", () => {
  it("AIDE_WORKER_HOST を優先する", () => {
    process.env["AIDE_WORKER_HOST"] = "macmini";
    assert.equal(workerHostName(), "macmini");
  });
});

describe("buildSwitchPayload", () => {
  it("切り替えの向きと理由、Zaimの再ログインの注意を載せる", () => {
    const payload = buildSwitchPayload(
      { at: "2026-11-22T00:00:00Z", from: "subpc", to: "macmini", reason: "failover" },
      "auto",
    );
    const embed = payload.embeds[0];
    assert.ok(embed.title.includes("subpc → macmini"));
    assert.ok(embed.description.includes("自動で引き継ぎました"));
    assert.ok(embed.description.includes("再ログイン"));
  });
});
