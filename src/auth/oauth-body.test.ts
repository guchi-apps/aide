import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { handleRegister, handleToken, MAX_BODY_BYTES, readForm } from "./oauth.ts";
import { resetRateLimits } from "./ratelimit.ts";

/**
 * 認証前に公開されているOAuthの口が、ボディの大きさと形式を守るか。
 * 実際のHTTPサーバーに流す（`Content-Length` の事前判定も、chunked の読み込み中の判定も通したい）。
 */

let server: Server;
let base = "";

before(async () => {
  server = createServer((req, res) => {
    void (async () => {
      if (req.url === "/echo") {
        const form = await readForm(req, res);
        if (!form) return;
        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify(Object.fromEntries(form)));
        return;
      }
      if (req.url === "/oauth/register") return handleRegister(req, res);
      if (req.url === "/oauth/token") return handleToken(req, res);
      res.writeHead(404).end();
    })().catch(() => {
      // 未処理の例外は本番では500になる。テストでは500として見えるようにする。
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

const post = (path: string, body: string, contentType: string): Promise<Response> =>
  fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": contentType }, body });

const FORM = "application/x-www-form-urlencoded";
const JSON_TYPE = "application/json";

describe("OAuthのボディ読み込み", () => {
  it("上限以内のフォームはそのまま読める", async () => {
    const res = await post("/echo", "a=1&b=%E3%81%82", FORM);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { a: "1", b: "あ" });
  });

  it("上限ちょうどのボディは受け付ける", async () => {
    const res = await post("/echo", `a=${"x".repeat(MAX_BODY_BYTES - 2)}`, FORM);
    assert.equal(res.status, 200);
  });

  it("上限を超えるフォームは413を返す", async () => {
    const res = await post("/echo", `a=${"x".repeat(MAX_BODY_BYTES)}`, FORM);
    assert.equal(res.status, 413);
    assert.equal(((await res.json()) as { error: string }).error, "invalid_request");
  });

  it("上限を超えるJSONも413を返す", async () => {
    const res = await post("/echo", JSON.stringify({ a: "x".repeat(MAX_BODY_BYTES) }), JSON_TYPE);
    assert.equal(res.status, 413);
  });

  it("Content-Length が無い（chunked）巨大なボディも、読みきる前に413を返す", async () => {
    // 上限の何千倍も送り続けるボディ。全部を読むのではなく、超えた時点で断ることを確かめる。
    let sent = 0;
    const chunk = Buffer.alloc(64 * 1024, 97);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 200) return controller.close();
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    const res = await fetch(`${base}/echo`, {
      method: "POST",
      headers: { "Content-Type": FORM },
      body: stream,
      duplex: "half",
    } as RequestInit);
    assert.equal(res.status, 413);
    assert.ok(sent < 200, "上限を超えても最後まで読み続けてはいけない");
  });

  it("不正なJSONは500ではなく invalid_request の400を返す", async () => {
    const res = await post("/echo", "{not json", JSON_TYPE);
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, "invalid_request");
  });

  it("JSONがオブジェクトでない場合も400を返す（null・配列・文字列）", async () => {
    for (const body of ["null", "[1,2]", '"text"', ""]) {
      const res = await post("/echo", body, JSON_TYPE);
      assert.equal(res.status, 400, `${JSON.stringify(body)} は400になるべき`);
    }
  });

  it("JSONの配列値は従来どおりカンマ連結で読める（動的登録の redirect_uris）", async () => {
    const res = await post("/echo", JSON.stringify({ redirect_uris: ["https://a/cb", "https://b/cb"] }), JSON_TYPE);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { redirect_uris: "https://a/cb,https://b/cb" });
  });
});

describe("認証前のOAuthエンドポイント", () => {
  it("POST /oauth/register は巨大なボディに413を返す", async () => {
    resetRateLimits();
    const res = await post("/oauth/register", "x".repeat(MAX_BODY_BYTES * 4), JSON_TYPE);
    assert.equal(res.status, 413);
  });

  it("POST /oauth/register は不正なJSONに400を返す", async () => {
    resetRateLimits();
    const res = await post("/oauth/register", "{oops", JSON_TYPE);
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, "invalid_request");
  });

  it("POST /oauth/token は巨大なボディに413を返す", async () => {
    const res = await post("/oauth/token", `grant_type=authorization_code&code=${"x".repeat(MAX_BODY_BYTES)}`, FORM);
    assert.equal(res.status, 413);
  });

  it("POST /oauth/token は不正なJSONに400を返す", async () => {
    const res = await post("/oauth/token", "{oops", JSON_TYPE);
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, "invalid_request");
  });
});
