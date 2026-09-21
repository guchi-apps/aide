import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";

import { normalizeName, toRoomButtons } from "../../core/connectors/myroom/control.ts";
import { resetPressHistory, roomButtonsTool, roomPressTool } from "./room-control.ts";
import type { ToolResult } from "../types.ts";

/**
 * myroom は同じプロセス内の模擬HTTPサーバーで代用する（本物の myroom・Nature Remo は叩かない）。
 */

const CTX = { sessionId: null };
const TOKEN = "test-control-token";

function parse(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

const BUTTONS_PAYLOAD = {
  configured: true,
  groups: [
    {
      id: "light",
      name: "照明",
      buttons: [
        { id: "l-on", label: "点ける", default_label: "on", hidden: false },
        { id: "l-off", label: "消す", default_label: "off", hidden: false },
      ],
    },
    { id: "tv", name: "テレビ", buttons: [{ id: "s-tv", label: "電源", default_label: "電源", hidden: true }] },
  ],
};

/** 模擬 myroom の振る舞い。テストごとに差し替える。 */
let sendStatus = 200;
let sendBody: unknown = { sent: true };
let buttonsStatus = 200;
let buttonsBody: unknown = BUTTONS_PAYLOAD;
let sent: string[] = [];

let server: Server;

before(async () => {
  server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ detail: "unauthorized" }));
      return;
    }
    const url = req.url ?? "";
    if (req.method === "GET" && url === "/api/internal/remote/buttons") {
      res.writeHead(buttonsStatus, { "content-type": "application/json" }).end(JSON.stringify(buttonsBody));
      return;
    }
    const match = /^\/api\/internal\/remote\/buttons\/([^/]+)\/send$/.exec(url);
    if (req.method === "POST" && match) {
      sent.push(decodeURIComponent(match[1]!));
      res.writeHead(sendStatus, { "content-type": "application/json" }).end(JSON.stringify(sendBody));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ detail: "Not Found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

after(() => {
  server.close();
});

beforeEach(() => {
  const { port } = server.address() as AddressInfo;
  process.env["AIDE_MYROOM_URL"] = `http://127.0.0.1:${port}`;
  process.env["AIDE_MYROOM_CONTROL_TOKEN"] = TOKEN;
  sendStatus = 200;
  sendBody = { sent: true };
  buttonsStatus = 200;
  buttonsBody = BUTTONS_PAYLOAD;
  sent = [];
  resetPressHistory();
});

describe("toRoomButtons・normalizeName", () => {
  it("グループ名とボタン名を「グループ / ボタン」にまとめ、形の崩れたボタンは落とす", () => {
    const buttons = toRoomButtons({
      groups: [{ name: "照明", buttons: [{ id: "a", label: "点ける" }, { id: "", label: "x" }, { id: "b" }] }],
    });
    assert.deepEqual(buttons, [{ id: "a", name: "照明 / 点ける", group: "照明", label: "点ける", hidden: false }]);
  });

  it("空白と区切りの揺れを無視して比べる", () => {
    assert.equal(normalizeName("照明 / 点ける"), normalizeName("照明/点ける"));
    assert.equal(normalizeName("照明 / 点ける"), normalizeName("照明　点ける"));
    assert.notEqual(normalizeName("照明 / 点ける"), normalizeName("照明 / 消す"));
  });
});

describe("aide_room_press の宣言", () => {
  it("id・expectedName が必須で、知らない引数を受け付けない", () => {
    assert.deepEqual(roomPressTool.inputSchema["required"], ["id", "expectedName"]);
    assert.equal(roomPressTool.inputSchema["additionalProperties"], false);
  });

  it("押す前に利用者へ確認する旨を説明文に書いている", () => {
    assert.match(roomPressTool.description, /確認を取ること/);
  });
});

describe("aide_room_buttons", () => {
  it("トークンが無ければ未設定として返し、myroom へは問い合わせない", async () => {
    delete process.env["AIDE_MYROOM_CONTROL_TOKEN"];
    const payload = parse(await roomButtonsTool.handler({}, CTX));
    assert.equal(payload["ok"], false);
    assert.match(String(payload["reason"]), /AIDE_MYROOM_CONTROL_TOKEN/);
  });

  it("隠したボタンも含めて一覧を返す", async () => {
    const payload = parse(await roomButtonsTool.handler({}, CTX));
    assert.equal(payload["ok"], true);
    const buttons = payload["buttons"] as Array<Record<string, unknown>>;
    assert.deepEqual(
      buttons.map((button) => button["name"]),
      ["照明 / 点ける", "照明 / 消す", "テレビ / 電源"],
    );
    assert.equal(buttons[2]!["hidden"], true);
  });

  it("myroom が操作用の内部APIを持たないバージョンなら unsupported", async () => {
    buttonsStatus = 404;
    buttonsBody = { detail: "Not Found" };
    const payload = parse(await roomButtonsTool.handler({}, CTX));
    assert.equal(payload["kind"], "unsupported");
  });

  it("トークンが一致しなければ unauthorized", async () => {
    process.env["AIDE_MYROOM_CONTROL_TOKEN"] = "wrong";
    const payload = parse(await roomButtonsTool.handler({}, CTX));
    assert.equal(payload["kind"], "unauthorized");
    assert.doesNotMatch(JSON.stringify(payload), /wrong/);
  });
});

describe("aide_room_press", () => {
  it("IDと名前が今の登録と一致すれば押す", async () => {
    const payload = parse(await roomPressTool.handler({ id: "l-on", expectedName: "照明/点ける" }, CTX));
    assert.equal(payload["ok"], true);
    assert.equal(payload["button"], "照明 / 点ける");
    assert.deepEqual(sent, ["l-on"]);
  });

  it("名前が食い違えば押さない", async () => {
    const payload = parse(await roomPressTool.handler({ id: "l-on", expectedName: "照明 / 消す" }, CTX));
    assert.equal(payload["kind"], "mismatch");
    assert.deepEqual(sent, []);
  });

  it("登録されていないIDなら押さず、一覧を添えて返す", async () => {
    const payload = parse(await roomPressTool.handler({ id: "nope", expectedName: "照明 / 点ける" }, CTX));
    assert.equal(payload["kind"], "not_found");
    assert.ok(Array.isArray(payload["buttons"]));
    assert.deepEqual(sent, []);
  });

  it("id・expectedName が欠けていれば myroom へ問い合わせずに弾く", async () => {
    const payload = parse(await roomPressTool.handler({ id: "l-on" }, CTX));
    assert.equal(payload["kind"], "invalid");
    assert.deepEqual(sent, []);
  });

  it("dryRun では押さず、押すことになるボタンの名前を返す", async () => {
    const payload = parse(
      await roomPressTool.handler({ id: "l-on", expectedName: "照明 / 点ける", dryRun: true }, CTX),
    );
    assert.equal(payload["ok"], true);
    assert.equal(payload["dryRun"], true);
    assert.equal(payload["wouldPress"], "照明 / 点ける");
    assert.deepEqual(sent, []);
  });

  it("dryRun は連打ガードを数え始めない（確認した直後に押せる）", async () => {
    await roomPressTool.handler({ id: "l-on", expectedName: "照明 / 点ける", dryRun: true }, CTX);
    const real = parse(await roomPressTool.handler({ id: "l-on", expectedName: "照明 / 点ける" }, CTX));
    assert.equal(real["ok"], true);
    assert.deepEqual(sent, ["l-on"]);
  });

  it("dryRun でも登録との突き合わせは本番と同じものを通す", async () => {
    const payload = parse(
      await roomPressTool.handler({ id: "l-on", expectedName: "照明 / 消す", dryRun: true }, CTX),
    );
    assert.equal(payload["kind"], "mismatch");
    assert.deepEqual(sent, []);
  });

  it("同じボタンを続けて押すと断り、allowRepeat を付ければ押す", async () => {
    await roomPressTool.handler({ id: "l-on", expectedName: "照明 / 点ける" }, CTX);
    const second = parse(await roomPressTool.handler({ id: "l-on", expectedName: "照明 / 点ける" }, CTX));
    assert.equal(second["kind"], "repeated");
    assert.deepEqual(sent, ["l-on"]);

    const third = parse(
      await roomPressTool.handler({ id: "l-on", expectedName: "照明 / 点ける", allowRepeat: true }, CTX),
    );
    assert.equal(third["ok"], true);
    assert.deepEqual(sent, ["l-on", "l-on"]);
  });

  it("別のボタンなら続けて押せる", async () => {
    await roomPressTool.handler({ id: "l-on", expectedName: "照明 / 点ける" }, CTX);
    const payload = parse(await roomPressTool.handler({ id: "l-off", expectedName: "照明 / 消す" }, CTX));
    assert.equal(payload["ok"], true);
    assert.deepEqual(sent, ["l-on", "l-off"]);
  });

  it("送れなかったことが確かな失敗なら、すぐ押し直せる", async () => {
    sendStatus = 429;
    sendBody = { detail: "Nature Remo の送信回数の上限に達しました。しばらく待ってからお試しください" };
    const first = parse(await roomPressTool.handler({ id: "l-on", expectedName: "照明 / 点ける" }, CTX));
    assert.equal(first["kind"], "rate_limited");
    assert.match(String(first["reason"]), /上限/);

    sendStatus = 200;
    sendBody = { sent: true };
    const second = parse(await roomPressTool.handler({ id: "l-on", expectedName: "照明 / 点ける" }, CTX));
    assert.equal(second["ok"], true);
  });

  it("送れたか分からない応答なら unknown とし、再送しないよう案内する", async () => {
    sendBody = { unexpected: true };
    const payload = parse(await roomPressTool.handler({ id: "l-on", expectedName: "照明 / 点ける" }, CTX));
    assert.equal(payload["kind"], "unknown");
    assert.match(String(payload["hint"]), /再送しない/);

    // 続けて押すのは断る（トグルのボタンが元に戻るのを防ぐ）。
    sendBody = { sent: true };
    const again = parse(await roomPressTool.handler({ id: "l-on", expectedName: "照明 / 点ける" }, CTX));
    assert.equal(again["kind"], "repeated");
  });

  it("myroom 側で送信が失敗したら、その理由を返す", async () => {
    sendStatus = 503;
    sendBody = { detail: "Nature Remo のトークンが設定されていません" };
    const payload = parse(await roomPressTool.handler({ id: "l-on", expectedName: "照明 / 点ける" }, CTX));
    assert.equal(payload["kind"], "unavailable");
    assert.equal(payload["reason"], "Nature Remo のトークンが設定されていません");
  });
});
