import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
// 型は実行時に読み込まれないため、置き場の差し替えより前に書いてよい。
import type { McpAccessEntry } from "./access-log.ts";

// 本番の記録を汚さないよう、読み込み前に置き場を一時ディレクトリへ差し替える。
// パスはモジュール読み込み時に確定するため、import より前に設定する必要がある。
const dir = await mkdtemp(join(tmpdir(), "aide-mcp-access-test-"));
process.env["AIDE_MCP_ACCESS_LOG_PATH"] = join(dir, "mcp-access.json");
const {
  ACCESS_LOG_PATH,
  flushMcpAccessLog,
  isQuietMethod,
  MAX_ENTRIES,
  readMcpAccessLog,
  recordMcpAccess,
  resetMcpAccessLog,
  summarizeMcpAccess,
} = await import("./access-log.ts");

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  resetMcpAccessLog();
  await rm(ACCESS_LOG_PATH, { force: true });
});

const NOW = new Date("2026-08-18T06:42:07.000Z");

function entry(overrides: Partial<McpAccessEntry> = {}): McpAccessEntry {
  return {
    at: NOW.toISOString(),
    method: "tools/call",
    tool: "aide_ping",
    client: "Claude",
    clientVersion: "1.4.2",
    ok: true,
    ms: 12,
    detail: "",
    ...overrides,
  };
}

describe("MCPアクセスの記録", () => {
  it("書いた記録をファイル越しに読み戻せる", async () => {
    await recordMcpAccess(entry({ tool: "aide_money_summary" }));
    await flushMcpAccessLog();

    // 再起動したのと同じ状態にしてから読む。デプロイをまたいでも残るのが要件（#116）。
    resetMcpAccessLog();
    const entries = await readMcpAccessLog();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.tool, "aide_money_summary");
  });

  it("失敗の理由は1行に畳み、長すぎるものは切る", async () => {
    await recordMcpAccess(entry({ ok: false, detail: `失敗\nしました\n  ${"x".repeat(400)}` }));
    const [saved] = await readMcpAccessLog();
    assert.ok(!saved!.detail.includes("\n"), "改行が残っている");
    assert.ok(saved!.detail.length <= 201, "上限を超えている");
  });

  it("上限を超えたら、接続確認から先に捨ててツールの呼び出しを残す", async () => {
    // 単純に古い順で捨てると、Claudeが投げ続ける ping だけが残り、
    // いちばん見たいツールの呼び出しが押し出される。
    await recordMcpAccess(entry({ tool: "aide_daily_briefing" }));
    for (let i = 0; i < MAX_ENTRIES; i += 1) {
      await recordMcpAccess(entry({ method: "ping", tool: null }));
    }

    const entries = await readMcpAccessLog();
    assert.equal(entries.length, MAX_ENTRIES);
    assert.ok(
      entries.some((saved) => saved.tool === "aide_daily_briefing"),
      "ツールの呼び出しが押し出されている",
    );
  });

  it("壊れたファイルを掴んでも、空から始めて記録を続ける", async () => {
    await writeFile(ACCESS_LOG_PATH, "{壊れている", "utf8");
    resetMcpAccessLog();

    await recordMcpAccess(entry());
    assert.equal((await readMcpAccessLog()).length, 1);
  });

  it("書き込めなくても呼び出し側へ例外を投げない", async () => {
    // 一時ファイルの名前をディレクトリで塞ぎ、書き込みを確実に失敗させる。
    // MCPの応答が記録の失敗で壊れてはいけない。
    const blocker = `${ACCESS_LOG_PATH}.${process.pid}.tmp`;
    await mkdir(blocker, { recursive: true });
    try {
      await recordMcpAccess(entry());
      await assert.doesNotReject(flushMcpAccessLog());
      // 記録そのものはメモリ上に残り、次の書き込みで拾える。
      assert.equal((await readMcpAccessLog()).length, 1);
    } finally {
      await rm(blocker, { recursive: true, force: true });
    }
  });
});

describe("記録の畳み方", () => {
  it("接続確認・一覧の取得・通知を畳む対象とする", () => {
    assert.equal(isQuietMethod("ping"), true);
    assert.equal(isQuietMethod("tools/list"), true);
    assert.equal(isQuietMethod("notifications/initialized"), true);
    assert.equal(isQuietMethod("tools/call"), false);
    assert.equal(isQuietMethod("initialize"), false);
  });
});

describe("記録の集計", () => {
  const entries: McpAccessEntry[] = [
    entry({ at: "2026-08-18T05:00:00.000Z", method: "initialize", tool: null, ms: 2 }),
    entry({ at: "2026-08-18T05:00:01.000Z", method: "tools/list", tool: null, ms: 1 }),
    entry({ at: "2026-08-18T05:10:00.000Z", tool: "aide_money_summary" }),
    entry({ at: "2026-08-18T06:00:00.000Z", tool: "aide_money_summary" }),
    entry({
      at: "2026-08-18T06:30:00.000Z",
      tool: "aide_dev_status",
      client: "Claude Code",
      clientVersion: null,
      ok: false,
      detail: "GitHub 401",
    }),
  ];

  it("新しい順に並べ、最後のアクセスからの経過が分かる", () => {
    const summary = summarizeMcpAccess(entries, NOW);
    assert.equal(summary.entries[0]?.tool, "aide_dev_status");
    assert.equal(summary.lastAt, "2026-08-18T06:30:00.000Z");
    assert.equal(summary.lastAgeMinutes, 12);
  });

  it("ツールごとの呼び出し回数を多い順に数える", () => {
    const summary = summarizeMcpAccess(entries, NOW);
    assert.deepEqual(summary.toolCounts, [
      { tool: "aide_money_summary", count: 2 },
      { tool: "aide_dev_status", count: 1 },
    ]);
    assert.equal(summary.toolCalls, 3);
    assert.equal(summary.failures, 1);
  });

  it("接続してきたクライアントを新しい順に重複なく並べる", () => {
    assert.deepEqual(summarizeMcpAccess(entries, NOW).clients, ["Claude Code", "Claude 1.4.2"]);
  });

  it("直近の失敗だけを注意にする", () => {
    assert.equal(summarizeMcpAccess(entries, NOW).severity, "warn");
    // 3日後から見れば、同じ失敗はもう注意ではない。
    // 古い失敗で鳴り続けると、本物の異常が埋もれる。
    const later = new Date("2026-08-21T06:42:07.000Z");
    assert.equal(summarizeMcpAccess(entries, later).severity, "ok");
  });

  it("記録が無い状態は異常ではなく「材料が無い」として扱う", () => {
    const summary = summarizeMcpAccess([], NOW);
    assert.equal(summary.severity, "unknown");
    assert.equal(summary.total, 0);
    assert.equal(summary.lastAt, null);
  });

  it("表に出すのは上限までで、畳まない行の数も数える", () => {
    const summary = summarizeMcpAccess(entries, NOW, 3);
    assert.equal(summary.entries.length, 3);
    assert.equal(summary.total, 5);
    // 直近3件はどれもツールの呼び出しなので、畳む行は無い。
    assert.equal(summary.visible, 3);
  });
});

describe("記録に残さないもの", () => {
  it("保存した内容にツールの引数・応答が含まれない", async () => {
    // 残高や部屋の状態が data/ に平文で溜まると、MCPが返すデータの置き場が1つ増える。
    await recordMcpAccess(entry({ tool: "aide_money_summary" }));
    await flushMcpAccessLog();

    const raw = await readFile(ACCESS_LOG_PATH, "utf8");
    const saved = (JSON.parse(raw) as { entries: Record<string, unknown>[] }).entries[0]!;
    assert.deepEqual(Object.keys(saved).sort(), [
      "at",
      "client",
      "clientVersion",
      "detail",
      "method",
      "ms",
      "ok",
      "tool",
    ]);
  });
});
