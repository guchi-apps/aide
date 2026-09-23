import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, it } from "node:test";
import { buildToolRegistry } from "../mcp/catalog.ts";
import { ToolRegistry } from "../mcp/registry.ts";
import type { Tool } from "../mcp/types.ts";
import { balancesTool } from "../mcp/tools/money.ts";
import { pingTool } from "../mcp/tools/ping.ts";
import { JOB_CATALOG } from "../worker/jobs/catalog.ts";
import { buildSections, ENDPOINTS, handleFeaturesPage, renderFeaturesPage } from "./features.ts";
import type { LoginOptions } from "./login.ts";

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
    const html = render(registryWith(pingTool, balancesTool));
    for (const tool of [pingTool, balancesTool]) {
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

  it("MCPツールを選ぶとtools/callのリクエストと入力スキーマを確認できる", () => {
    const html = render(registryWith(pingTool));
    assert.match(html, /class="nm feature-trigger"[^>]*>aide_ping/);
    assert.ok(html.includes("&quot;method&quot;: &quot;tools/call&quot;"));
    assert.ok(html.includes("&quot;name&quot;: &quot;aide_ping&quot;"));
    assert.ok(html.includes("入力スキーマ:"));
    assert.ok(html.includes("JSON-RPCのresult.content[0].text"));
    assert.ok(html.includes("データなし・未取得"));
  });

  it("HTTPエンドポイントを選ぶと呼び出しと成功・失敗・空データの意味を確認できる", () => {
    const html = render(registryWith(pingTool));
    assert.match(html, /class="nm feature-trigger"[^>]*>\/api\/money\/transactions/);
    assert.ok(html.includes("GET /api/money/transactions"));
    assert.ok(html.includes("明細が無い場合は空配列（[]）を返す"));
    assert.ok(html.includes("401: 認証情報が無い、または一致しない。"));
    assert.ok(html.includes("409: 前回の登録結果が確定しておらず、再送不可。"));
  });

  it("詳細に渡すリクエスト情報をHTMLとして解釈しない", () => {
    const tool: Tool = {
      name: "aide_detail",
      description: "詳細のエスケープ確認",
      inputSchema: { type: "object", properties: { value: { description: "<script>" } } },
      handler: () => ({ content: [] }),
    };
    const html = render(registryWith(tool));
    assert.ok(html.includes("&lt;script&gt;"));
    assert.ok(!html.includes('<pre><script>'));
  });

  it("worker ジョブがカタログの分だけ載る", () => {
    const html = render(registryWith(pingTool));
    for (const job of JOB_CATALOG) {
      assert.ok(html.includes(job.name), `${job.name} が出力に含まれていない`);
      assert.ok(html.includes(job.interval), `${job.name} の実行間隔が出力に含まれていない`);
    }
  });

  it("Open-Meteo の帰属表示（CC BY 4.0）を出す", () => {
    // 無料枠の利用条件そのものなので、消えたら気づけるようにしておく。
    const html = render(registryWith(pingTool));
    assert.ok(html.includes("Open-Meteo"));
    assert.ok(html.includes("CC BY 4.0"));
    assert.ok(html.includes('href="https://creativecommons.org/licenses/by/4.0/"'));
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

  it("接続先URLが狭い画面で枠からはみ出さないよう、値の列を折り返せるようにする", () => {
    // 切れ目のないURLは、値の列が min-width:0 と折り返しの許可を持たないと枠を突き抜ける（#356）。
    const html = render(registryWith(pingTool));
    const rule = html.match(/\.connect dd\{([^}]*)\}/)?.[1] ?? "";
    assert.ok(rule.includes("min-width:0"), ".connect dd に min-width:0 が無い");
    assert.ok(rule.includes("overflow-wrap:anywhere"), ".connect dd に overflow-wrap:anywhere が無い");
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

  it("説明文の **太字** と `コード` を記号のまま出さず、太字・等幅にする（#364）", () => {
    const marked: Tool = {
      name: "aide_marked",
      description: "**書き込みを伴う。** `on` / `off` を返す。",
      inputSchema: { type: "object" },
      handler: () => ({ content: [] }),
    };
    const html = render(registryWith(marked));
    assert.ok(html.includes('<span class="ds"><strong>書き込みを伴う。</strong> <code>on</code> / <code>off</code> を返す。</span>'));
    // 名前・注記は説明文ではないため変換しない。
    assert.match(html, /class="nm feature-trigger"[^>]*>aide_marked/);
  });

  it("実際に登録されているツールの説明に、記号のままの ** が残らない（#364）", () => {
    const html = render(buildToolRegistry());
    assert.ok(html.includes("<strong>"), "太字が1つも出ていない");
    assert.ok(!html.includes("**"), "説明文に ** が記号のまま残っている");
  });

  it("ツールが1つも無くても壊れない", () => {
    const html = render(new ToolRegistry());
    assert.ok(html.startsWith("<!doctype html>"));
    assert.ok(html.includes("まだありません"));
  });

  it("ヘッダーの右端にログイン中の操作を出す", () => {
    const html = renderFeaturesPage(buildSections(registryWith(pingTool)), "https://aide.example.com", {
      headerAction: '<form action="/status/logout"></form>',
    });
    assert.ok(html.includes('action="/status/logout"'));
    assert.ok(!html.includes("認証が無効です"));
  });

  it("認証が無効な環境でだけ警告を出す", () => {
    const html = renderFeaturesPage(buildSections(registryWith(pingTool)), "https://aide.example.com", {
      authDisabled: true,
    });
    assert.ok(html.includes("認証が無効です"));
    assert.ok(!render(registryWith(pingTool)).includes("認証が無効です"));
  });

  it("このページ自身が、ログインが要ると説明する", () => {
    // 「認証は不要」と書いたまま関門を付けると、実態と食い違う。
    const endpoint = ENDPOINTS.find((item) => item.name === "/features");
    assert.ok(endpoint);
    assert.ok(!endpoint.description.includes("認証は不要"));
    assert.ok(endpoint.description.includes("ログイン"));
  });
});

describe("機能一覧ページの関門", () => {
  it("認証が無効な環境では、ログインなしで機能一覧を返す", async () => {
    // 認証が有効な経路は署名鍵を data/auth へ作るため、ここでは当てない（実サーバーで確かめる）。
    const options: LoginOptions = {
      authConfig: { enabled: false, password: null },
      supabase: null,
      baseUrl: "https://aide.example.com",
      registry: registryWith(pingTool),
    };
    let status = 0;
    let headers: Record<string, string | string[]> = {};
    let body = "";
    const res = {
      writeHead(code: number, h: Record<string, string | string[]>) {
        status = code;
        headers = h;
        return this;
      },
      end(chunk: string) {
        body = chunk;
      },
    } as unknown as ServerResponse;

    await handleFeaturesPage({ headers: {} } as IncomingMessage, res, options);

    assert.equal(status, 200);
    assert.equal(headers["Cache-Control"], "no-store");
    assert.ok(body.includes("<h1>機能一覧</h1>"));
    assert.ok(body.includes(pingTool.name));
    assert.ok(body.includes("認証が無効です"));
  });
});
