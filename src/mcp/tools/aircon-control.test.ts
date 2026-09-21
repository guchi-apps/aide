import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  parseAirconCommand,
  planAirconChange,
  toAirconState,
} from "../../core/connectors/myroom/aircon-control.ts";
import type { AirconState } from "../../core/connectors/myroom/aircon-control.ts";
import { airconControlTool } from "./aircon-control.ts";
import type { ToolResult } from "../types.ts";

/**
 * myroom は同じプロセス内の模擬HTTPサーバーで代用する（本物の myroom・白くまくんは叩かない）。
 */

const CTX = { sessionId: null };
const TOKEN = "test-control-token";

function parse(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

async function call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return parse(await airconControlTool.handler({ acId: 1, expectedName: "リビング", ...args }, CTX));
}

const BASE_STATE = {
  ac_id: 1,
  name: "リビング",
  power: "ON",
  mode: "COOLING",
  room_temperature: 28.5,
  target_temperature: 26,
  humidity: 50,
  fan_speed: "AUTO",
  fan_swing: "VERTICAL",
  online: true,
  model: "RAC-X",
};

/** 模擬 myroom の振る舞い。テストごとに差し替える。 */
let stateStatus = 200;
let stateBody: unknown = BASE_STATE;
/** 2回目以降の状態の読み取り（読み戻し）で返すもの。null なら送る前と同じ。 */
let readbackBody: unknown = null;
let readbackStatus: number | null = null;
/** 送信への応答を、JSONではない文字列で返す（応答が読めない場合の再現）。 */
let controlRawText: string | null = null;
let controlStatus = 200;
let controlBody: unknown = null;
let controlHeaders: Record<string, string> = {};
let stateReads = 0;
let sentBodies: Array<Record<string, unknown>> = [];

let server: Server;

before(async () => {
  server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ detail: "unauthorized" }));
      return;
    }
    const url = req.url ?? "";
    if (req.method === "GET" && url === "/api/internal/aircon/units/1/state") {
      stateReads += 1;
      const readback = stateReads > 1;
      const body = readback && readbackBody !== null ? readbackBody : stateBody;
      const status = readback && readbackStatus !== null ? readbackStatus : stateStatus;
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      return;
    }
    if (req.method === "POST" && url === "/api/internal/aircon/units/1/control") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        sentBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
        if (controlRawText !== null) {
          res.writeHead(controlStatus, { "content-type": "text/plain" }).end(controlRawText);
          return;
        }
        // 既定の応答は、送られた項目を現在の状態へ重ねたもの（myroom の「送信後の状態」）。
        res
          .writeHead(controlStatus, { "content-type": "application/json", ...controlHeaders })
          .end(JSON.stringify(controlBody ?? { ...BASE_STATE, ...sentBodies.at(-1)! }));
      });
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
  stateStatus = 200;
  stateBody = BASE_STATE;
  readbackBody = null;
  readbackStatus = null;
  controlRawText = null;
  controlStatus = 200;
  controlBody = null;
  controlHeaders = {};
  stateReads = 0;
  sentBodies = [];
});

describe("parseAirconCommand", () => {
  it("大文字小文字を問わず受け、指定した項目だけを取り出す", () => {
    const parsed = parseAirconCommand({ power: "on", mode: "cooling", targetTemperature: 26.5, fanSpeed: "lv2" });
    assert.deepEqual(parsed, {
      ok: true,
      command: { power: "ON", mode: "COOLING", targetTemperature: 26.5, fanSpeed: "LV2" },
    });
  });

  it("変える項目が1つも無ければ断る", () => {
    assert.equal(parseAirconCommand({}).ok, false);
  });

  it("知らない値・範囲外・0.5刻みでない温度は丸めずに断る", () => {
    assert.equal(parseAirconCommand({ power: "maybe" }).ok, false);
    assert.equal(parseAirconCommand({ mode: "DRY_COOL" }).ok, false);
    assert.equal(parseAirconCommand({ targetTemperature: 15.5 }).ok, false);
    assert.equal(parseAirconCommand({ targetTemperature: 32.5 }).ok, false);
    assert.equal(parseAirconCommand({ targetTemperature: 27.3 }).ok, false);
    assert.equal(parseAirconCommand({ targetTemperature: "26" }).ok, false);
    assert.equal(parseAirconCommand({ targetTemperature: 16 }).ok, true);
    assert.equal(parseAirconCommand({ targetTemperature: 32 }).ok, true);
  });
});

describe("planAirconChange", () => {
  const current = toAirconState(BASE_STATE) as AirconState;

  it("実際に変わる項目だけを、変更前と並べて返す", () => {
    const plan = planAirconChange(current, { power: "ON", targetTemperature: 24, fanSpeed: "AUTO" });
    assert.deepEqual(plan.changes, [{ field: "targetTemperature", from: 26, to: 24 }]);
  });

  it("すべて今と同じなら変更なし", () => {
    assert.deepEqual(planAirconChange(current, { mode: "COOLING", targetTemperature: 26 }).changes, []);
  });

  it("自動運転との行き来で温度の指定が無ければ、置き換わる旨を添える", () => {
    assert.match(planAirconChange(current, { mode: "AUTO" }).note ?? "", /シフト量/);
    const auto = { ...current, mode: "AUTO" };
    assert.match(planAirconChange(auto, { mode: "HEATING" }).note ?? "", /26℃/);
    assert.equal(planAirconChange(current, { mode: "HEATING" }).note, undefined);
  });
});

describe("aide_aircon_control の宣言", () => {
  it("acId・expectedName が必須で、知らない引数を受け付けない", () => {
    assert.deepEqual(airconControlTool.inputSchema["required"], ["acId", "expectedName"]);
    assert.equal(airconControlTool.inputSchema["additionalProperties"], false);
  });

  it("送る前に利用者へ確認する旨と、再送しない旨を説明文に書いている", () => {
    assert.match(airconControlTool.description, /確認を取ること/);
    assert.match(airconControlTool.description, /再送せず/);
  });
});

describe("aide_aircon_control", () => {
  it("トークンが無ければ未設定として返し、myroom へは何も送らない", async () => {
    delete process.env["AIDE_MYROOM_CONTROL_TOKEN"];
    const payload = await call({ power: "OFF" });
    assert.equal(payload["ok"], false);
    assert.match(String(payload["reason"]), /AIDE_MYROOM_CONTROL_TOKEN/);
    assert.equal(stateReads, 0);
    assert.deepEqual(sentBodies, []);
  });

  it("引数が不正なら myroom へ問い合わせずに弾く", async () => {
    const noId = parse(await airconControlTool.handler({ expectedName: "リビング", power: "OFF" }, CTX));
    assert.equal(noId["kind"], "invalid");
    const badTemp = await call({ targetTemperature: 40 });
    assert.equal(badTemp["kind"], "invalid");
    const nothing = await call({});
    assert.equal(nothing["kind"], "invalid");
    assert.equal(stateReads, 0);
    assert.deepEqual(sentBodies, []);
  });

  it("指定した項目だけを送り、変更前と読み戻した結果を返す", async () => {
    readbackBody = { ...BASE_STATE, power: "OFF" };
    const payload = await call({ power: "OFF" });
    assert.equal(payload["ok"], true);
    assert.equal(payload["sent"], true);
    assert.deepEqual(sentBodies, [{ power: "OFF" }]);
    assert.deepEqual(payload["changes"], [{ field: "power", from: "ON", to: "OFF" }]);
    assert.equal((payload["before"] as Record<string, unknown>)["power"], "ON");
    assert.equal((payload["readback"] as Record<string, unknown>)["matches"], true);
  });

  it("設定温度は target_temperature として送る", async () => {
    await call({ mode: "HEATING", targetTemperature: 22.5, fanSpeed: "LV2" });
    assert.deepEqual(sentBodies, [{ mode: "HEATING", target_temperature: 22.5, fan_speed: "LV2" }]);
  });

  it("読み戻しがまだ古くても失敗とはせず、確認できていないと伝える", async () => {
    // 読み戻しが変更前のまま（反映待ち）。
    const payload = await call({ power: "OFF" });
    assert.equal(payload["ok"], true);
    assert.equal(payload["sent"], true);
    assert.equal((payload["readback"] as Record<string, unknown>)["matches"], false);
    assert.match(String(payload["note"]), /確認できていません/);
  });

  it("読み戻しに失敗しても、送ったこと自体は成功として返す", async () => {
    readbackStatus = 502;
    readbackBody = { detail: "エアコンにつながりませんでした" };
    const payload = await call({ power: "OFF" });
    assert.equal(payload["ok"], true);
    assert.equal(payload["sent"], true);
    assert.equal((payload["readback"] as Record<string, unknown>)["matches"], null);
  });

  it("名前が食い違えば送らない", async () => {
    const payload = await call({ expectedName: "寝室", power: "OFF" });
    assert.equal(payload["kind"], "mismatch");
    assert.deepEqual(sentBodies, []);
  });

  it("空白や区切りの揺れは同じ名前とみなす", async () => {
    stateBody = { ...BASE_STATE, name: "1階 リビング" };
    const payload = await call({ expectedName: "1階/リビング", power: "OFF", dryRun: true });
    assert.equal(payload["ok"], true);
  });

  it("オフラインのエアコンには送らない", async () => {
    stateBody = { ...BASE_STATE, online: false };
    const payload = await call({ power: "OFF" });
    assert.equal(payload["kind"], "offline");
    assert.deepEqual(sentBodies, []);
  });

  it("今と同じ値なら何も送らない", async () => {
    const payload = await call({ power: "ON", targetTemperature: 26 });
    assert.equal(payload["ok"], true);
    assert.equal(payload["changed"], false);
    assert.deepEqual(sentBodies, []);
  });

  it("自動運転では設定温度を受けず、送らない", async () => {
    const toAuto = await call({ mode: "AUTO", targetTemperature: 24 });
    assert.equal(toAuto["kind"], "invalid");

    stateBody = { ...BASE_STATE, mode: "AUTO", target_temperature: 0 };
    const inAuto = await call({ targetTemperature: 24 });
    assert.equal(inAuto["kind"], "invalid");
    assert.deepEqual(sentBodies, []);
  });

  it("dryRun では送らず、変更前→変更後だけを返す", async () => {
    const payload = await call({ targetTemperature: 24, dryRun: true });
    assert.equal(payload["ok"], true);
    assert.equal(payload["dryRun"], true);
    assert.deepEqual(payload["wouldChange"], [{ field: "targetTemperature", from: 26, to: 24 }]);
    assert.deepEqual(sentBodies, []);
  });

  it("dryRun でも名前の突き合わせ・オフラインの判定は本番と同じものを通す", async () => {
    const mismatch = await call({ expectedName: "寝室", power: "OFF", dryRun: true });
    assert.equal(mismatch["kind"], "mismatch");
    stateBody = { ...BASE_STATE, online: false };
    const offline = await call({ power: "OFF", dryRun: true });
    assert.equal(offline["kind"], "offline");
  });

  it("myroom がエアコンの内部APIを持たないバージョンなら unsupported", async () => {
    stateStatus = 404;
    stateBody = { detail: "Not Found" };
    const payload = await call({ power: "OFF" });
    assert.equal(payload["kind"], "unsupported");
    assert.deepEqual(sentBodies, []);
  });

  it("エアコンが見つからない404は not_found として理由を返す", async () => {
    stateStatus = 404;
    stateBody = { detail: "エアコン（ID:1）が見つかりません" };
    const payload = await call({ power: "OFF" });
    assert.equal(payload["kind"], "not_found");
    assert.match(String(payload["reason"]), /見つかりません/);
  });

  it("トークンが一致しなければ unauthorized で、トークンを応答へ出さない", async () => {
    process.env["AIDE_MYROOM_CONTROL_TOKEN"] = "wrong";
    const payload = await call({ power: "OFF" });
    assert.equal(payload["kind"], "unauthorized");
    assert.doesNotMatch(JSON.stringify(payload), /wrong/);
  });

  it("送信が429なら rate_limited とし、待つ秒数と再試行しない旨を返す", async () => {
    controlStatus = 429;
    controlBody = { detail: "混み合っています。しばらく待ってからもう一度お試しください" };
    controlHeaders = { "retry-after": "300" };
    const payload = await call({ power: "OFF" });
    assert.equal(payload["kind"], "rate_limited");
    assert.equal(payload["retryAfterSec"], 300);
    assert.match(String(payload["hint"]), /再試行しない/);
    assert.equal((payload["before"] as Record<string, unknown>)["power"], "ON");
  });

  it("myroom が値を受け付けなければ rejected", async () => {
    controlStatus = 422;
    controlBody = { detail: "設定温度は16〜32℃の範囲で指定してください" };
    const payload = await call({ targetTemperature: 24 });
    assert.equal(payload["kind"], "rejected");
    assert.match(String(payload["reason"]), /16〜32/);
  });

  it("送信の応答が読めなければ unknown とし、再送しないよう案内する", async () => {
    // 200 だが JSON でない。送信自体は済んでいる可能性がある。
    controlRawText = "ok";
    const payload = await call({ power: "OFF" });
    assert.equal(payload["kind"], "unknown");
    assert.match(String(payload["hint"]), /再送しないでください/);
  });
});
