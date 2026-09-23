import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthConfig } from "../auth/config.ts";
import type { CreateIssueOutcome } from "../core/connectors/github/write.ts";
import { buildToolRegistry } from "../mcp/catalog.ts";
import { ToolRegistry } from "../mcp/registry.ts";
import { pingTool } from "../mcp/tools/ping.ts";
import { ENDPOINTS } from "./features.ts";
import type { LoginOptions } from "./login.ts";
import {
  CALLERS,
  GROUPS,
  handleMapIssue,
  handleMapPage,
  renderMapPage,
  renderNarrowMap,
  renderWideMap,
  syncMap,
  type MapDeps,
  type SyncView,
} from "./map.ts";
import { MAP_SYNC_FOOTNOTE } from "./map-sync.ts";

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

  for (const [label, render, box] of [
    ["横長", renderWideMap, { left: 408, right: 592 }],
    ["縦長", renderNarrowMap, { left: 90, right: 270 }],
  ] as const) {
    it(`${label}の図の中央は AIde のロゴで、旧 AIDE のブロックは残っていない`, () => {
      const svg = render();
      assert.equal(svg.match(/aria-label="AIde"/g)?.length, 1, "ロゴがちょうど1つ載っていない");
      assert.ok(!svg.includes("hub-name"), "旧AIDEの文字が残っている");
      assert.doesNotMatch(svg, /<text[^>]*>AIDE<\/text>/);
      // 取得・整形・中継は画像に焼かず、文字として残す。
      assert.match(svg, /<text[^>]*class="hub-sub">取得・整形・中継<\/text>/);
      // ロゴが囲みからはみ出して、周りの矢印と重ならない。
      const logo = /<svg class="logo" x="([\d.]+)" y="[\d.]+" width="(\d+)" height="\d+"/.exec(svg);
      assert.ok(logo, "ロゴの位置が読めない");
      const x = Number(logo[1]);
      assert.ok(x >= box.left && x + Number(logo[2]) <= box.right, `ロゴが囲み（${box.left}〜${box.right}）に収まっていない`);
    });
  }

  it("読むと書くで矢じりの向きを分ける", () => {
    const svg = renderWideMap();
    // ops-dashboard は読むだけ、aide-bot は書くだけ。
    assert.match(svg, /marker-start="url\(#mw-r\)"/);
    assert.match(svg, /marker-end="url\(#mw-w\)"/);
  });

  it("読む・書く両方あるコネクタは、矢印を2本に分ける（#426）", () => {
    const destinations = GROUPS.flatMap((group) => group.apps);
    assert.ok(destinations.some((d) => d.dir === "both"), "検証対象の「両方向」コネクタが無い");
    const readCount = destinations.filter((d) => d.dir === "read" || d.dir === "both").length;
    const writeCount = destinations.filter((d) => d.dir === "write" || d.dir === "both").length;

    for (const [prefix, render] of [
      ["mw-", renderWideMap],
      ["mn-", renderNarrowMap],
    ] as const) {
      const svg = render();
      const starts = svg.match(new RegExp(`marker-start="url\\(#${prefix}r\\)"`, "g")) ?? [];
      const ends = svg.match(new RegExp(`marker-end="url\\(#${prefix}w\\)"`, "g")) ?? [];
      assert.equal(starts.length, readCount, `${prefix}: 読む矢印の本数`);
      assert.equal(ends.length, writeCount, `${prefix}: 書く矢印の本数`);
      // 1本の線の両端に矢じりを付ける（分割前の表現）行が残っていない。
      assert.doesNotMatch(svg, /<path[^>]*marker-start="url\(#\w+-r\)"[^>]*marker-end="url\(#\w+-w\)"/);
    }
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

  it("移動した行には、pushStateでも効く.arrivedを付け直して強調する", () => {
    const html = renderMapPage();
    // pushStateは:targetを更新しないため、クラスで強調する。同じ行の再選択でもやり直せるよう外してから付ける。
    assert.ok(html.includes('target.classList.remove("arrived")'));
    assert.ok(html.includes('target.classList.add("arrived")'));
    // 戻る操作でも同じ動きにする。
    assert.match(html, /addEventListener\("popstate", \(\) => \{[^}]*arriveAt\(target\)/);
  });

  it("強調は数秒残ってから消え、:targetと.arrivedで別名の同じ動きを使う", () => {
    const html = renderMapPage();
    assert.match(html, /\.apps li\.arrived\{animation:arrive-again 5s ease-out forwards\}/);
    assert.match(html, /\.apps li:target\{animation:arrive 5s ease-out forwards\}/);
    for (const name of ["arrive", "arrive-again"]) {
      assert.ok(
        html.includes(
          `@keyframes ${name}{0%,70%{background:var(--focus);outline-color:var(--focus-line)}100%{background:transparent;outline-color:transparent}}`,
        ),
        `${name} のkeyframesが無い`,
      );
    }
  });

  it("MCPで使う側はツール名を並べず本数だけにする", () => {
    const html = renderMapPage();
    const claude = CALLERS.find((caller) => caller.id === "claude")!;
    assert.ok(html.includes(`MCPツール ${claude.uses.length}本`));
  });

  it("MCPの本数表示を押すと、使える全ツールと説明を読める", () => {
    const html = renderMapPage();
    const claude = CALLERS.find((caller) => caller.id === "claude")!;
    assert.match(html, new RegExp(`popovertarget="map-detail-\\d+"[^>]*>MCPツール ${claude.uses.length}本`));
    for (const tool of claude.uses) assert.ok(html.includes(tool), `${tool} が詳細に無い`);
    assert.ok(html.includes("Claudeアプリ・Claude Codeから利用できるMCPツールです。"));
  });

  it("MCPツールとHTTP APIのチップを押すと説明を開ける", () => {
    const html = renderMapPage();
    assert.match(html, /<button type="button" class="detail-trigger" popovertarget="map-detail-\d+" aria-haspopup="dialog">aide_balances<\/button>/);
    assert.match(html, /<button type="button" class="detail-trigger" popovertarget="map-detail-\d+" aria-haspopup="dialog">\/api\/money\/summary<\/button>/);
    assert.ok(html.includes("残高一覧・保有銘柄"));
    assert.ok(html.includes("個人アプリ向けの読み取りAPI。"));
    assert.ok(html.includes('popover="auto" role="dialog"'));
    assert.ok(html.includes("popovertargetaction=\"hide\""));
  });

  it("説明のポップアップでも **太字** を記号のまま出さない（#364）", () => {
    const html = renderMapPage();
    assert.ok(/<p>[^<]*<strong>/.test(html), "ポップアップ本文に太字が出ていない");
    assert.ok(!html.includes("**"), "ポップアップに ** が記号のまま残っている");
  });

  it("認証が無効なら警告する", () => {
    assert.ok(renderMapPage({ authDisabled: true }).includes("認証が無効です"));
    assert.ok(!renderMapPage().includes("認証が無効です"));
  });
});

// ---- 機能の同期（#355） ----

/** 差がある同期結果。ping以外の宣言済みツールはすべて「実在しない」になり、`/api/` は「未掲載」にならない。 */
function diffView(overrides: Partial<SyncView> = {}): SyncView {
  const registry = new ToolRegistry();
  registry.register(pingTool);
  registry.register({ ...pingTool, name: "aide_brand_new", description: "新しく足したツール。" });
  return {
    result: syncMap(registry),
    syncedAt: "2026-09-21 14:32",
    canDraftIssue: true,
    issueTarget: "guchi-apps/aide",
    ...overrides,
  };
}

const calmView: SyncView = {
  result: { added: [], removed: [], same: 33 },
  syncedAt: "2026-09-21 14:32",
  canDraftIssue: true,
  issueTarget: "guchi-apps/aide",
};

describe("機能の同期（ボタン）", () => {
  it("押す前は、同期ボタンだけが出て、結果も未掲載の機能も出さない", () => {
    const html = renderMapPage();
    assert.match(html, /<form class="sync-area" method="get" action="\/map"/);
    assert.ok(html.includes('<input type="hidden" name="sync" value="1">'));
    assert.ok(html.includes("機能を同期"));
    assert.ok(!html.includes('class="result'));
    assert.ok(!html.includes("未掲載の機能"));
    assert.ok(!html.includes("Issueを起案"));
  });

  it("押した後は、同期した日時をボタンの脇に出す", () => {
    assert.ok(renderMapPage({ sync: diffView() }).includes("同期 2026-09-21 14:32"));
  });

  it("実際の登録簿と図の宣言は、いまは削除の差を持たない", () => {
    // MCPツールの実在は、宣言のテスト（上）でも確かめている。ここは同期の集め方が同じ結論になることの確認。
    assert.deepEqual(syncMap(buildToolRegistry()).removed, []);
  });
});

describe("機能の同期（差がある結果）", () => {
  it("追加・削除・変更なしの件数と同期時刻を結果欄に出す", () => {
    const view = diffView();
    const html = renderMapPage({ sync: view });
    assert.match(html, /<h2>同期しました<\/h2><span class="t">2026-09-21 14:32<\/span>/);
    assert.ok(html.includes(`＋ 追加 <b>${view.result.added.length}</b>`));
    assert.ok(html.includes(`－ 削除 <b>${view.result.removed.length}</b>`));
    assert.ok(html.includes(`＝ 変更なし <b>${view.result.same}</b>`));
    // 追加は、登録簿にだけある新しいツール1本。
    assert.equal(view.result.added.length, 1);
    assert.ok(view.result.removed.length > 0);
    assert.ok(html.includes("図の宣言は書き換えません"));
  });

  it("図に無い機能を「未掲載の機能」に、名前と説明つきで出す", () => {
    const html = renderMapPage({ sync: diffView() });
    assert.ok(html.includes('id="found"'));
    assert.match(html, /<section class="card wide found" id="found">/);
    assert.ok(html.includes('<span class="nm">aide_brand_new</span>'));
    assert.ok(html.includes("新しく足したツール。"));
    assert.ok(html.includes('<a href="#found">未掲載の機能へ</a>'));
  });

  it("図に残っている実在しない機能に、取り消し線つきの印を付け、その行へのリンクを出す", () => {
    const html = renderMapPage({ sync: diffView() });
    assert.match(html, /<span class="gone" title="いまのAIDEには無い"><s>aide_balances<\/s>　－ 実在しない<\/span>/);
    // 最初に印が付く行（使う側の先頭）へ飛ぶ。
    assert.ok(html.includes('<a href="#from-claude">実在しない項目へ</a>'));
  });

  it("結果欄のリンクも、図のリンクと同じ「画面中央へ移動して強調」の動きに含める", () => {
    assert.ok(renderMapPage({ sync: diffView() }).includes('.result .jump a[href^="#"]'));
  });

  it("名前や説明に含まれるHTMLはエスケープする", () => {
    const registry = new ToolRegistry();
    registry.register({ ...pingTool, name: "<b>x</b>", description: "<script>alert(1)</script>" });
    const html = renderMapPage({ sync: { ...diffView(), result: syncMap(registry) } });
    assert.ok(!html.includes("<b>x</b>"));
    assert.ok(html.includes("&lt;b&gt;x&lt;/b&gt;"));
    assert.ok(!html.includes("<script>alert(1)</script>"));
  });

  it("差がある状態の画面で、既存の図と一覧はそのまま残る", () => {
    const html = renderMapPage({ sync: diffView() });
    assert.ok(html.includes('id="from-claude"'));
    assert.ok(html.includes('id="to-zaim"'));
    assert.ok(html.includes("<svg"));
  });
});

describe("機能の同期（Issueの起案）", () => {
  it("差があり起票できる環境なら、起案の確認（タイトルと本文の下書き）を出す", () => {
    const html = renderMapPage({ sync: diffView() });
    assert.ok(html.includes("Issueを起案…"));
    assert.match(html, /<section id="issue-draft" class="detail-popover draft" popover="auto" role="dialog"/);
    assert.match(html, /<form class="draft-actions" method="post" action="\/map\/issue"/);
    assert.ok(html.includes("guchi-apps/aide に、ラベル"));
    assert.ok(html.includes("70.needs-decision"));
    assert.ok(html.includes("アプリ連携の図を機能の実態に合わせる（追加1・削除"));
    assert.ok(html.includes("`aide_brand_new`"));
  });

  it("画面には、起票へ送る入力欄を持たない（内容はサーバーが組み立てる）", () => {
    const html = renderMapPage({ sync: diffView() });
    const form = html.slice(html.indexOf('action="/map/issue"'));
    assert.ok(!form.slice(0, form.indexOf("</form>")).includes("<input"));
    assert.ok(!form.slice(0, form.indexOf("</form>")).includes("<textarea"));
  });

  it("起票できない環境では、起案を出さず、設定の有無も文言に書かない", () => {
    const html = renderMapPage({ sync: diffView({ canDraftIssue: false }) });
    assert.ok(!html.includes("Issueを起案"));
    assert.ok(!html.includes('action="/map/issue"'));
    // ページ全体には既存のツール説明（「トークン」など）が載るので、同期の結果欄だけを見る。
    const result = html.slice(html.indexOf('<section class="result'), html.indexOf('<section class="mapcard">'));
    assert.ok(result.length > 0);
    assert.doesNotMatch(result, /AIDE_GITHUB|トークン|未設定/);
    // 差そのものは従来どおり出る。
    assert.ok(html.includes("未掲載の機能"));
  });

  it("差が無ければ、起案は出ない", () => {
    const html = renderMapPage({ sync: calmView });
    assert.ok(html.includes("差はありません"));
    assert.ok(!html.includes("Issueを起案"));
    assert.ok(!html.includes("未掲載の機能"));
    assert.match(html, /＝ 変更なし <b>33<\/b>/);
  });

  it("起票した後は、番号とリンクを出し、起案のボタンを出さない（二重に起票させない）", () => {
    const html = renderMapPage({
      sync: diffView({ issue: { kind: "done", number: 379, url: "https://github.com/guchi-apps/aide/issues/379" } }),
    });
    assert.ok(html.includes("Issueを起票しました"));
    assert.ok(html.includes('href="https://github.com/guchi-apps/aide/issues/379"'));
    assert.ok(html.includes("guchi-apps/aide #379 を開く"));
    assert.ok(html.includes("起票済み"));
    assert.ok(!html.includes("Issueを起案"));
  });

  it("起票に失敗したときは、丸めた文言だけを出し、起案をやり直せる", () => {
    const html = renderMapPage({ sync: diffView({ issue: { kind: "failed" } }) });
    assert.match(html, /<p class="fail" role="alert">Issueを起票できませんでした。/);
    assert.ok(html.includes("Issueを起案…"));
  });
});

// ---- ハンドラ ----

interface Captured {
  status: number;
  headers: Record<string, string | string[]>;
  body: string;
}

function fakeRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, headers: {}, body: "" };
  const res = {
    writeHead(status: number, headers?: Record<string, string | string[]>) {
      captured.status = status;
      captured.headers = headers ?? {};
      return res;
    },
    end(body?: string) {
      captured.body = body ?? "";
      return res;
    },
  };
  return { res: res as unknown as ServerResponse, captured };
}

function fakeReq(url: string, method = "GET"): IncomingMessage {
  return { url, method, headers: {}, resume() {} } as unknown as IncomingMessage;
}

/** ping しか持たない登録簿。図が挙げるツールの大半が「実在しない」になるので、差は必ずある。 */
function loginOptions(): LoginOptions {
  const registry = new ToolRegistry();
  registry.register(pingTool);
  const authConfig: AuthConfig = { enabled: false, password: null };
  return { authConfig, supabase: null, baseUrl: "http://localhost", registry };
}

const NOW = () => new Date("2026-09-21T05:32:00Z");
const CONFIG = { token: "test-only-token", org: "guchi-apps" };

function issueDeps(overrides: Partial<MapDeps> = {}): { deps: MapDeps; calls: Parameters<NonNullable<MapDeps["createIssue"]>>[] } {
  const calls: Parameters<NonNullable<MapDeps["createIssue"]>>[] = [];
  const outcome: CreateIssueOutcome = { ok: true, number: 379, repo: "guchi-apps/aide" };
  return {
    calls,
    deps: {
      now: NOW,
      readIssueConfig: () => CONFIG,
      createIssue: async (...args) => {
        calls.push(args);
        return outcome;
      },
      ...overrides,
    },
  };
}

describe("GET /map（同期）", () => {
  it("?sync=1 でなければ、従来どおり同期の結果を出さない", async () => {
    const { res, captured } = fakeRes();
    await handleMapPage(fakeReq("/map"), res, loginOptions(), issueDeps().deps);
    assert.equal(captured.status, 200);
    assert.ok(!captured.body.includes('class="result'));
  });

  it("?sync=1 なら、その場でコードと突き合わせた結果を出す", async () => {
    const { res, captured } = fakeRes();
    await handleMapPage(fakeReq("/map?sync=1"), res, loginOptions(), issueDeps().deps);
    assert.ok(captured.body.includes("同期しました"));
    assert.ok(captured.body.includes("同期 2026-09-21 14:32"));
    assert.ok(captured.body.includes("Issueを起案…"));
    // トークンの値が画面に出ない。
    assert.ok(!captured.body.includes(CONFIG.token));
  });

  it("起票の設定が無い環境では、起案を出さない", async () => {
    const { res, captured } = fakeRes();
    await handleMapPage(fakeReq("/map?sync=1"), res, loginOptions(), issueDeps({ readIssueConfig: () => null }).deps);
    assert.ok(captured.body.includes("同期しました"));
    assert.ok(!captured.body.includes("Issueを起案"));
  });

  it("起票の戻り（?issue=番号）は、同期も兼ねて番号とリンクを出す", async () => {
    const { res, captured } = fakeRes();
    await handleMapPage(fakeReq("/map?sync=1&issue=379"), res, loginOptions(), issueDeps().deps);
    assert.ok(captured.body.includes("Issueを起票しました"));
    assert.ok(captured.body.includes("https://github.com/guchi-apps/aide/issues/379"));
  });

  it("?label_dropped=1 なら、ラベルが付いたとは言わず、手で付けるよう促す", async () => {
    const { res, captured } = fakeRes();
    await handleMapPage(fakeReq("/map?sync=1&issue=379&label_dropped=1"), res, loginOptions(), issueDeps().deps);
    assert.ok(captured.body.includes("を付けられませんでした"));
    assert.ok(!captured.body.includes("着手するかは issue-deck で決めます"));
  });

  it("番号でない ?issue= の値は信用せず、リンクにしない", async () => {
    for (const value of ["abc", "1/../../x", "379%22%3E%3Cscript%3E", "12345678901"]) {
      const { res, captured } = fakeRes();
      await handleMapPage(fakeReq(`/map?sync=1&issue=${value}`), res, loginOptions(), issueDeps().deps);
      assert.ok(!captured.body.includes("Issueを起票しました"), value);
      assert.ok(!captured.body.includes("github.com/guchi-apps/aide/issues"), value);
    }
  });

  it("?issue_error=1 なら、失敗の文言を出し、起案をやり直せる", async () => {
    const { res, captured } = fakeRes();
    await handleMapPage(fakeReq("/map?sync=1&issue_error=1"), res, loginOptions(), issueDeps().deps);
    assert.ok(captured.body.includes("Issueを起票できませんでした"));
    assert.ok(captured.body.includes("Issueを起案…"));
  });
});

describe("POST /map/issue", () => {
  it("同期し直した差から組み立てた内容で起票し、番号つきで /map へ戻す", async () => {
    const { deps, calls } = issueDeps();
    const { res, captured } = fakeRes();
    await handleMapIssue(fakeReq("/map/issue", "POST"), res, loginOptions(), deps);

    assert.equal(captured.status, 303);
    assert.equal(captured.headers["Location"], "/map?sync=1&issue=379");
    assert.equal(calls.length, 1);
    const [config, input] = calls[0]!;
    assert.deepEqual(config, CONFIG);
    assert.equal(input.repo, "aide");
    assert.match(input.title, /^アプリ連携の図を機能の実態に合わせる（追加\d+・削除\d+）$/);
    assert.ok(input.body?.includes("同期した日時: 2026-09-21 14:32"));
    // Claudeアプリ経由の脚注ではなく、この画面からの脚注で起票する。
    assert.equal(input.footnote, MAP_SYNC_FOOTNOTE);
  });

  it("画面から何を送っても、起票の内容には使わない", async () => {
    const { deps, calls } = issueDeps();
    const req = {
      ...fakeReq("/map/issue?title=乗っ取り&body=x", "POST"),
      // 本文があっても読まない（resume で捨てる）。
    } as IncomingMessage;
    await handleMapIssue(req, fakeRes().res, loginOptions(), deps);
    assert.ok(!calls[0]![1].title.includes("乗っ取り"));
    assert.ok(!(calls[0]![1].body ?? "").includes("乗っ取り"));
  });

  it("ログインしていなければ、起票せず /map（ログイン画面）へ戻す", async () => {
    const { deps, calls } = issueDeps({ currentSession: async () => null });
    const { res, captured } = fakeRes();
    await handleMapIssue(fakeReq("/map/issue", "POST"), res, loginOptions(), deps);
    assert.equal(captured.status, 303);
    assert.equal(captured.headers["Location"], "/map");
    assert.equal(calls.length, 0);
  });

  it("起票の設定が無ければ、GitHubへは何も送らず、失敗として戻す", async () => {
    const { deps, calls } = issueDeps({ readIssueConfig: () => null });
    const { res, captured } = fakeRes();
    await handleMapIssue(fakeReq("/map/issue", "POST"), res, loginOptions(), deps);
    assert.equal(captured.headers["Location"], "/map?sync=1&issue_error=1");
    assert.equal(calls.length, 0);
  });

  it("起票が断られたら、理由は画面へ出さず、失敗として戻す", async () => {
    const { deps } = issueDeps({
      createIssue: async () => ({ ok: false, reason: "HTTP 403（AIDE_GITHUB_ISSUE_TOKEN に Issues: Read and write が無い）" }),
    });
    const { res, captured } = fakeRes();
    await handleMapIssue(fakeReq("/map/issue", "POST"), res, loginOptions(), deps);
    assert.equal(captured.headers["Location"], "/map?sync=1&issue_error=1");
    assert.ok(!String(captured.headers["Location"]).includes("403"));
  });

  it("既定ラベルが落ちた起票は、警告つきで戻す", async () => {
    const { deps } = issueDeps({
      createIssue: async () => ({ ok: true, number: 379, warning: "既定ラベルを付けられませんでした" }),
    });
    const { res, captured } = fakeRes();
    await handleMapIssue(fakeReq("/map/issue", "POST"), res, loginOptions(), deps);
    assert.equal(captured.headers["Location"], "/map?sync=1&issue=379&label_dropped=1");
  });

  it("番号が返らなかった成功は、番号なしの起票済みとして戻す", async () => {
    const { deps } = issueDeps({ createIssue: async () => ({ ok: true }) });
    const { res, captured } = fakeRes();
    await handleMapIssue(fakeReq("/map/issue", "POST"), res, loginOptions(), deps);
    assert.equal(captured.headers["Location"], "/map?sync=1&issue=ok");
  });
});
