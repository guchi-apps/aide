import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ToolRegistry } from "../mcp/registry.ts";
import type { Tool } from "../mcp/types.ts";
import { moneySummaryTool } from "../mcp/tools/money.ts";
import { pingTool } from "../mcp/tools/ping.ts";
import { JOB_CATALOG } from "../worker/jobs/catalog.ts";
import { buildSections, renderFeaturesPage } from "./features.ts";

function render(registry: ToolRegistry, baseUrl = "https://aide.example.com"): string {
  return renderFeaturesPage(buildSections(registry), baseUrl);
}

function registryWith(...tools: Tool[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  return registry;
}

describe("機能一覧ページ", () => {
  it("登録済みのMCPツールが名前と説明つきで載る", () => {
    const html = render(registryWith(pingTool, moneySummaryTool));
    for (const tool of [pingTool, moneySummaryTool]) {
      assert.ok(html.includes(tool.name), `${tool.name} が出力に含まれていない`);
      // 説明は分割して連結しているため、先頭の一節だけ照合する。
      assert.ok(html.includes(tool.description.slice(0, 12)), `${tool.name} の説明が出力に含まれていない`);
    }
  });

  it("ツールを増やせば何もしなくても載る", () => {
    const extra: Tool = {
      name: "aide_extra",
      description: "あとから足したツール",
      inputSchema: { type: "object" },
      handler: () => ({ content: [] }),
    };
    assert.ok(!render(registryWith(pingTool)).includes("aide_extra"));
    assert.ok(render(registryWith(pingTool, extra)).includes("aide_extra"));
  });

  it("worker ジョブがカタログの分だけ載る", () => {
    const html = render(registryWith(pingTool));
    for (const job of JOB_CATALOG) {
      assert.ok(html.includes(job.name), `${job.name} が出力に含まれていない`);
      assert.ok(html.includes(job.interval), `${job.name} の実行間隔が出力に含まれていない`);
    }
  });

  it("アイコンとPWAマニフェストを head で指す", () => {
    const html = render(registryWith(pingTool));
    assert.match(html, /rel="icon"[^>]*favicon-32\.png/);
    assert.ok(html.includes('rel="manifest" href="/manifest.webmanifest"'));
  });

  it("HTTPエンドポイントが載る", () => {
    const html = render(registryWith(pingTool));
    for (const path of [
      "/mcp",
      "/features",
      "/health",
      "/oauth/token",
      "/api/cache/:key",
      "/api/money/summary",
    ]) {
      assert.ok(html.includes(path), `${path} が出力に含まれていない`);
    }
  });

  it("接続先URLに /mcp を付けて出す", () => {
    assert.ok(render(registryWith(pingTool), "https://aide.example.com").includes("https://aide.example.com/mcp"));
  });

  it("ツールの説明に含まれるHTMLをエスケープする", () => {
    const evil: Tool = {
      name: "aide_<script>",
      description: `<script>alert("x")</script> & 'quoted'`,
      inputSchema: { type: "object" },
      handler: () => ({ content: [] }),
    };
    const html = render(registryWith(evil));
    assert.ok(!html.includes("<script>alert"), "生の script タグが出力に混ざっている");
    assert.ok(html.includes("&lt;script&gt;alert"));
    assert.ok(html.includes("&amp;"));
    assert.ok(html.includes("&#39;quoted&#39;"));
  });

  it("ツールが1つも無くても壊れない", () => {
    const html = render(new ToolRegistry());
    assert.ok(html.startsWith("<!doctype html>"));
    assert.ok(html.includes("まだありません"));
  });
});
