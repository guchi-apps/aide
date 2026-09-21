import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FeatureItem } from "./features.ts";
import {
  buildIssueDraft,
  collectSync,
  formatSyncedAt,
  hasDifference,
  isAppFacingApi,
  MAP_SYNC_FOOTNOTE,
} from "./map-sync.ts";

const tool = (name: string): FeatureItem => ({ name, description: `${name}の説明` });
const endpoint = (name: string, meta = "GET"): FeatureItem => ({ name, meta, description: `${name}の説明` });

describe("isAppFacingApi", () => {
  it("/api/ のエンドポイントだけを、アプリとのつながりとして数える", () => {
    assert.equal(isAppFacingApi("/api/money/summary"), true);
    assert.equal(isAppFacingApi("/health"), false);
    assert.equal(isAppFacingApi("/oauth/token"), false);
    assert.equal(isAppFacingApi("/map"), false);
  });

  it("workerがAIDEへ送り込む受け口（パラメータ付き）は対象にしない", () => {
    assert.equal(isAppFacingApi("/api/cache/:key"), false);
  });
});

describe("collectSync", () => {
  it("図に載っていないMCPツールとAPIを、追加として集める", () => {
    const result = collectSync({
      tools: [tool("aide_ping"), tool("aide_new")],
      endpoints: [endpoint("/api/money/summary"), endpoint("/api/room/status")],
      declared: [{ owner: "Claude", uses: ["aide_ping", "/api/money/summary"] }],
    });
    assert.deepEqual(
      result.added.map((feature) => [feature.name, feature.kind]),
      [
        ["aide_new", "MCPツール"],
        ["/api/room/status", "HTTP API"],
      ],
    );
    assert.equal(result.added[1]?.meta, "GET");
    assert.deepEqual(result.removed, []);
    assert.equal(result.same, 2);
  });

  it("図に残っているのに実在しない機能を、どこに載っているかと併せて削除として集める", () => {
    const result = collectSync({
      tools: [tool("aide_ping")],
      endpoints: [endpoint("/api/money/summary")],
      declared: [
        { owner: "Claude", uses: ["aide_ping", "aide_old"] },
        { owner: "Asset Manager", uses: ["/api/money/summary", "/api/gone"] },
        // 使う側と繋ぐ先の両方に同じ名前で載っていても、ひとつとして数える。
        { owner: "Asset Manager", uses: ["/api/gone"] },
        { owner: "car-care", uses: ["aide_old"] },
      ],
    });
    assert.deepEqual(result.removed, [
      { name: "aide_old", owners: ["Claude", "car-care"] },
      { name: "/api/gone", owners: ["Asset Manager"] },
    ]);
    assert.deepEqual(result.added, []);
  });

  it("アプリとのつながりでないエンドポイントは、図に無くても追加にしない", () => {
    const result = collectSync({
      tools: [],
      endpoints: [endpoint("/health"), endpoint("/oauth/token", "POST"), endpoint("/api/cache/:key", "POST")],
      declared: [],
    });
    assert.deepEqual(result.added, []);
    assert.equal(hasDifference(result), false);
  });

  it("図が挙げる /api/ 以外のパスは、機能一覧に実在すれば削除にしない", () => {
    const result = collectSync({
      tools: [],
      endpoints: [endpoint("/mcp", "POST")],
      declared: [{ owner: "Claude", uses: ["/mcp"] }],
    });
    assert.deepEqual(result.removed, []);
  });

  it("差が無ければ、変更なしの数だけを返す", () => {
    const result = collectSync({
      tools: [tool("aide_ping")],
      endpoints: [endpoint("/api/money/summary")],
      declared: [{ owner: "x", uses: ["aide_ping", "/api/money/summary"] }],
    });
    assert.equal(hasDifference(result), false);
    assert.equal(result.same, 2);
  });
});

describe("buildIssueDraft", () => {
  const result = collectSync({
    tools: [tool("aide_new")],
    endpoints: [endpoint("/api/room/status")],
    declared: [{ owner: "Claude", uses: ["aide_old"] }],
  });

  it("タイトルに追加・削除の件数を入れ、本文に名前を並べる", () => {
    const draft = buildIssueDraft(result, "2026-09-21 14:32");
    assert.equal(draft.title, "アプリ連携の図を機能の実態に合わせる（追加2・削除1）");
    assert.match(draft.body, /### 図に載っていない（追加）/);
    assert.ok(draft.body.includes("- `aide_new`（MCPツール）"));
    assert.ok(draft.body.includes("- `/api/room/status`（HTTP API・GET）"));
    assert.match(draft.body, /### 図に残っているが実在しない（削除）/);
    assert.ok(draft.body.includes("- `aide_old`（Claude）"));
    assert.ok(draft.body.endsWith("同期した日時: 2026-09-21 14:32"));
  });

  it("差の無い側の見出しは出さない", () => {
    const onlyAdded = buildIssueDraft({ added: result.added, removed: [], same: 0 }, "t");
    assert.ok(!onlyAdded.body.includes("実在しない（削除）"));
    const onlyRemoved = buildIssueDraft({ added: [], removed: result.removed, same: 0 }, "t");
    assert.ok(!onlyRemoved.body.includes("図に載っていない（追加）"));
  });

  it("脚注はClaudeアプリ経由を名乗らず、この画面からの起票だと名乗る", () => {
    assert.ok(MAP_SYNC_FOOTNOTE.includes("アプリ連携画面"));
    assert.ok(!MAP_SYNC_FOOTNOTE.includes("Claudeアプリ"));
    assert.ok(MAP_SYNC_FOOTNOTE.includes("<!-- aide:created-via-map-sync -->"));
  });
});

describe("formatSyncedAt", () => {
  it("日本時間で「年-月-日 時:分」にする", () => {
    // UTC 05:32 は JST 14:32。
    assert.equal(formatSyncedAt(new Date("2026-09-21T05:32:00Z")), "2026-09-21 14:32");
    // 日付をまたぐ場合もJSTで数える。
    assert.equal(formatSyncedAt(new Date("2026-09-21T16:05:00Z")), "2026-09-22 01:05");
  });
});
