import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildToolRegistry } from "./catalog.ts";

/**
 * 登録簿の形を守る（#373）。
 *
 * MCPツールは「1つの問い」ごとに立てる方針へ寄せた。**方針は description の文面にしか
 * 残らないので、畳み戻し・取り違えをここで機械的に止める。**
 */

const TOOLS = buildToolRegistry().list();
const NAMES = TOOLS.map((tool) => tool.name);

function tool(name: string) {
  const found = TOOLS.find((candidate) => candidate.name === name);
  assert.ok(found, `登録されていないツール: ${name}`);
  return found;
}

describe("MCPツールの登録簿", () => {
  it("問いの単位へ分けたツールがすべて登録されている", () => {
    for (const name of [
      "aide_balances",
      "aide_fixed_costs",
      "aide_host_status",
      "aide_uptime_monitors",
      "aide_service_quotas",
      "aide_room_sensors",
      "aide_aircon_status",
      "aide_printer_status",
      "aide_weather",
      "aide_garbage_collection",
      "aide_dev_status",
      "aide_repo_status",
      "aide_repo_labels",
    ]) {
      assert.ok(NAMES.includes(name), `登録されていない: ${name}`);
    }
  });

  it("畳んでいた頃のツールは残っていない", () => {
    // 名前が残っていると、同じ問いに答えるツールが2セット並ぶ。
    for (const name of [
      "aide_money_summary",
      "aide_ops_status",
      "aide_room_status",
      "aide_daily_briefing",
    ]) {
      assert.ok(!NAMES.includes(name), `分割前のツールが残っている: ${name}`);
    }
  });

  it("ツール名が重複しない", () => {
    assert.equal(new Set(NAMES).size, NAMES.length);
  });

  it("すべてのツールが説明と入力スキーマを持つ", () => {
    for (const entry of TOOLS) {
      // 説明はClaudeのツール選択そのもの。空のまま登録されると、選ばれないか誤って選ばれる。
      assert.ok(entry.description.length > 20, `説明が短すぎる: ${entry.name}`);
      assert.equal(entry.inputSchema["type"], "object", `inputSchema が object でない: ${entry.name}`);
      // 知らない引数を黙って受けると、Claudeの綴り間違いが素通りする。
      assert.equal(entry.inputSchema["additionalProperties"], false, `additionalProperties: ${entry.name}`);
    }
  });

  it("書き込みツールは dryRun を持つ", () => {
    // **どれも取り消せない経路。** 送る前に内容を確かめる口を必ず残す。
    for (const name of [
      "aide_zaim_payment",
      "aide_create_issue",
      "issue_deck_upload_image",
      "aide_create_event",
      "aide_room_press",
      "aide_aircon_control",
    ]) {
      const properties = tool(name).inputSchema["properties"] as Record<string, unknown>;
      assert.ok(properties["dryRun"], `dryRun が無い: ${name}`);
      assert.match(tool(name).description, /dryRun/, `dryRun の案内が説明に無い: ${name}`);
    }
  });

  it("分けた相手を説明文で名指ししている", () => {
    // 名指しが無いと、似た問いでどちらを呼べばよいかをClaudeが決められない。
    const pairs: [string, RegExp][] = [
      ["aide_balances", /aide_fixed_costs/],
      ["aide_fixed_costs", /aide_balances/],
      ["aide_host_status", /aide_uptime_monitors/],
      ["aide_uptime_monitors", /aide_service_quotas/],
      ["aide_service_quotas", /aide_host_status/],
      ["aide_room_sensors", /aide_aircon_status/],
      ["aide_aircon_status", /aide_room_sensors/],
      ["aide_aircon_status", /aide_aircon_control/],
      ["aide_aircon_control", /aide_aircon_status/],
      ["aide_room_buttons", /aide_aircon_control/],
      ["aide_printer_status", /aide_room_sensors/],
      ["aide_room_sensors", /aide_printer_status/],
      ["aide_weather", /aide_room_sensors/],
      ["aide_garbage_collection", /aide_schedule/],
      ["aide_dev_status", /aide_repo_status/],
      ["aide_repo_status", /aide_repo_labels/],
      ["aide_repo_labels", /aide_create_issue/],
    ];
    for (const [name, pattern] of pairs) {
      assert.match(tool(name).description, pattern, `使い分けが説明に無い: ${name}`);
    }
  });

  it("俯瞰は引数を取らず、1リポジトリ向けは repo が必須", () => {
    assert.deepEqual(tool("aide_dev_status").inputSchema["properties"], {});
    for (const name of ["aide_repo_status", "aide_repo_labels"]) {
      assert.deepEqual(tool(name).inputSchema["required"], ["repo"], name);
    }
  });
});
