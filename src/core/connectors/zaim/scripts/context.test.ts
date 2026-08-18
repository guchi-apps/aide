import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { ZAIM_CONTEXT_OPTIONS } from "./context.mjs";

/**
 * Zaimの「最終更新」はブラウザのタイムゾーンで描画され、取り込み側（`parse.ts`）は
 * それをJSTとして解釈する。subpc のシステムTZはUTCなので、コンテキストを1つでも
 * 素で作ると**そこだけ9時間ずれ**、当日更新できた口座が「更新できなかった」と通知される（#89）。
 *
 * ずれても例外にはならず、値が9時間古く見えるだけで誰も気づけない。**気づけない不具合は
 * 検査で塞ぐ**（`src/deploy-env-wiring.test.ts` と同じ考え方）。
 */

const SCRIPTS_DIR = fileURLToPath(new URL("./", import.meta.url));

describe("Zaimのブラウザコンテキスト", () => {
  it("タイムゾーンをJSTに固定している", () => {
    assert.equal(ZAIM_CONTEXT_OPTIONS.timezoneId, "Asia/Tokyo");
  });

  it("newContext を呼ぶスクリプトはすべて共通設定を渡している", async () => {
    const names = (await readdir(SCRIPTS_DIR)).filter((name) => name.endsWith(".mjs"));
    const checked: string[] = [];

    for (const name of names) {
      const source = await readFile(new URL(name, import.meta.url), "utf8");
      for (const line of source.split("\n")) {
        if (!line.includes("newContext(")) continue;
        checked.push(name);
        assert.ok(
          line.includes("ZAIM_CONTEXT_OPTIONS"),
          `${name} の newContext が ZAIM_CONTEXT_OPTIONS を渡していない: ${line.trim()}`,
        );
      }
    }

    // 検査そのものが空振りしていないことを確かめる（呼び出しが1つも無ければ上のループは通る）。
    assert.ok(checked.length > 0, "newContext の呼び出しを1つも見つけられなかった");
  });
});
