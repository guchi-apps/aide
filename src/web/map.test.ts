import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildToolRegistry } from "../mcp/catalog.ts";
import { ENDPOINTS } from "./features.ts";
import { CALLERS, GROUPS, renderMapPage, renderNarrowMap, renderWideMap } from "./map.ts";

/** `src/server.ts` と同じ登録簿。ツールを足せば、ここも自動で追従する。 */
const REGISTERED_TOOLS = buildToolRegistry()
  .list()
  .map((tool) => tool.name);

const ALL_USES = [...CALLERS.flatMap((c) => c.uses), ...GROUPS.flatMap((g) => g.apps.flatMap((a) => a.uses))];

describe("アプリ連携の宣言", () => {
  it("載せたMCPツールはすべて実在する", () => {
    for (const name of ALL_USES.filter((use) => !use.startsWith("/"))) {
      assert.ok(REGISTERED_TOOLS.includes(name), `登録されていないツール: ${name}`);
    }
  });

  it("載せたHTTPエンドポイントはすべて機能一覧に載っている", () => {
    const paths = ENDPOINTS.map((endpoint) => endpoint.name);
    for (const path of ALL_USES.filter((use) => use.startsWith("/"))) {
      assert.ok(paths.includes(path), `機能一覧に無いエンドポイント: ${path}`);
    }
  });

  it("登録したMCPツールは、どれかの使う側に載っている", () => {
    // 載っていないと、そのツールを誰が使うのかが図から読めない。
    const used = new Set(CALLERS.flatMap((caller) => caller.uses));
    for (const name of REGISTERED_TOOLS) assert.ok(used.has(name), `使う側が無いツール: ${name}`);
  });

  it("一覧のページ内リンク先（id）が重ならない", () => {
    const ids = [
      ...CALLERS.map((caller) => `from-${caller.id}`),
      ...GROUPS.flatMap((group) => group.apps.map((app) => `to-${app.id}`)),
    ];
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe("アプリ連携の図", () => {
  for (const [label, render] of [
    ["横長", renderWideMap],
    ["縦長", renderNarrowMap],
  ] as const) {
    it(`${label}の図にすべてのアプリが載り、一覧へリンクする`, () => {
      const svg = render();
      for (const caller of CALLERS) assert.ok(svg.includes(`href="#from-${caller.id}"`), caller.id);
      for (const app of GROUPS.flatMap((group) => group.apps)) {
        assert.ok(svg.includes(`href="#to-${app.id}"`), app.id);
      }
      assert.ok(!svg.includes("NaN"), "座標の計算が壊れている");
    });
  }

  it("読むと書くで矢じりの向きを分ける", () => {
    const svg = renderWideMap();
    // subscription-lists は読むだけ、aide-bot は書くだけ。
    assert.match(svg, /marker-start="url\(#mw-r\)"/);
    assert.match(svg, /marker-end="url\(#mw-w\)"/);
  });
});

describe("アプリ連携の画面", () => {
  it("図の下に、つながりごとの一覧を出す", () => {
    const html = renderMapPage();
    assert.ok(html.includes('id="from-claude"'));
    assert.ok(html.includes('id="to-zaim"'));
    assert.ok(html.includes('aria-current="page"'));
    assert.ok(html.includes(">アプリ連携<"));
    // 外した画面へのナビは残さない。
    assert.ok(!html.includes('href="/status"'));
    assert.ok(!html.includes('href="/knowledge"'));
  });

  it("図から選んだ項目を画面中央へ移動する", () => {
    const html = renderMapPage();
    assert.ok(html.includes(".mapcard a[href^=\"#\"]"));
    assert.ok(html.includes('history.pushState(null, "", href)'));
    assert.ok(html.includes('scrollIntoView({ behavior: "smooth", block: "center" })'));
  });

  it("MCPで使う側はツール名を並べず本数だけにする", () => {
    const html = renderMapPage();
    const claude = CALLERS.find((caller) => caller.id === "claude")!;
    assert.ok(html.includes(`MCPツール ${claude.uses.length}本`));
  });

  it("認証が無効なら警告する", () => {
    assert.ok(renderMapPage({ authDisabled: true }).includes("認証が無効です"));
    assert.ok(!renderMapPage().includes("認証が無効です"));
  });
});
