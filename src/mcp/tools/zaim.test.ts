import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolResult } from "../types.ts";
import { ZAIM_API_RETIRED_REASON, zaimMasterTool, zaimPaymentTool } from "./zaim.ts";

/**
 * Zaim公式APIの終了で廃止したツール（aide#714）。**どんな引数でも登録・問い合わせをせず、
 * 廃止の理由を返す**ことだけを押さえる。
 */

const CTX = { sessionId: null };

function parse(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe("廃止したZaimツール", () => {
  for (const tool of [zaimMasterTool, zaimPaymentTool]) {
    it(`${tool.name} は廃止の理由と代わりの手段を返す`, async () => {
      const result = await tool.handler(
        { amount: 1200, date: "2026-08-19", categoryId: 101, genreId: 10101 },
        CTX,
      );
      assert.equal(result.isError, false);
      const body = parse(result);
      assert.equal(body["ok"], false);
      assert.equal(body["kind"], "retired");
      assert.equal(body["reason"], ZAIM_API_RETIRED_REASON);
      assert.equal(typeof body["alternative"], "string");
    });
  }
});
