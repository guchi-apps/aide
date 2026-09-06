import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { createEventTool } from "./create-event.ts";
import type { ToolResult } from "../types.ts";

/**
 * **この経路は取り消せない。** ネットワークへ出る手前（未設定・入力不正）までしか踏まない
 * （テストから外部サービス＝DaySpanは叩かない）。
 */

const CTX = { sessionId: null };

function parse(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe("aide_create_event の宣言", () => {
  it("取り消し・修正はできない旨を説明文に書いている", () => {
    assert.match(createEventTool.description, /取り消し・修正はできない/);
  });

  it("知らない引数を受け付けない", () => {
    assert.equal(createEventTool.inputSchema["additionalProperties"], false);
  });

  it("title・date が必須", () => {
    assert.deepEqual(createEventTool.inputSchema["required"], ["title", "date"]);
  });
});

describe("aide_create_event ハンドラ", () => {
  beforeEach(() => {
    delete process.env["AIDE_DAYSPAN_WRITE_TOKEN"];
  });

  it("AIDE_DAYSPAN_WRITE_TOKEN が無ければ未設定として返し、DaySpanへは送らない", async () => {
    const result = await createEventTool.handler({ title: "歯医者", date: "2026-09-10" }, CTX);
    const payload = parse(result);
    assert.equal(payload["ok"], false);
    assert.match(payload["reason"] as string, /未設定/);
    assert.equal(result.isError, false);
  });

  it("入力が不正なら invalid を返し、DaySpanへは送らない（トークンがあっても）", async () => {
    process.env["AIDE_DAYSPAN_WRITE_TOKEN"] = "secret";
    const result = await createEventTool.handler({ title: "", date: "2026-09-10" }, CTX);
    const payload = parse(result);
    assert.equal(payload["ok"], false);
    assert.equal(payload["kind"], "invalid");
    assert.equal(result.isError, false);
  });
});
