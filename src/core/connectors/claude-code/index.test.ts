import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  collectClaudeCodeSessions,
  parseProcStartTicks,
  projectFromCwd,
  remoteControlUrl,
  shortenHome,
  toSession,
  tmuxSessionName,
} from "./index.ts";
import type { ClaudeSessionFile } from "./types.ts";

/**
 * 台帳の読み取りは純粋関数へ寄せてあるので、テストもそこへ集中させる。
 * 収集そのもの（`collectClaudeCodeSessions`）は、生きているプロセスの判定と
 * 壊れた台帳の扱いだけを一時ディレクトリで確かめる。
 */

/** state から starttime までを埋めた `/proc/<pid>/stat` の後半部分を作る。 */
function statFields(starttime: string): string {
  return ["S", ...Array.from({ length: 18 }, () => "0"), starttime].join(" ");
}

describe("parseProcStartTicks", () => {
  it("starttime（22番目のフィールド）を返す", () => {
    // 実物と同じ並びの縮約。閉じ括弧の後ろ（3番目 = state）から数えて20番目が starttime。
    assert.equal(
      parseProcStartTicks(`202000 (node) ${statFields("33478363")} 0 0 0`),
      "33478363",
    );
  });

  it("プロセス名に空白や括弧が入っていても位置がずれない", () => {
    // 前から数えると壊れる形。閉じ括弧の最後の出現より後ろだけを数える必要がある。
    assert.equal(parseProcStartTicks(`7 (my prog (x)) ${statFields("42")}`), "42");
  });

  it("フィールドが足りなければ null", () => {
    assert.equal(parseProcStartTicks("7 (node) S 1 2 3"), null);
  });
});

describe("tmuxSessionName", () => {
  it("セッション名だけを取り出す", () => {
    assert.equal(tmuxSessionName("aide-issue-123:@85.%85"), "aide-issue-123");
  });

  it("tmux の外で動いていれば null", () => {
    assert.equal(tmuxSessionName(undefined), null);
  });
});

describe("shortenHome", () => {
  it("ホームディレクトリを ~ に置き換える", () => {
    assert.equal(shortenHome("/home/guchi/apps/aide", "/home/guchi"), "~/apps/aide");
    assert.equal(shortenHome("/home/guchi", "/home/guchi"), "~");
  });

  it("ホームの外はそのまま（前方一致だけで削らない）", () => {
    assert.equal(shortenHome("/home/guchi2/apps", "/home/guchi"), "/home/guchi2/apps");
  });
});

describe("projectFromCwd", () => {
  it("worktree でも本体と同じプロジェクト名になる", () => {
    assert.equal(projectFromCwd("~/apps/aide-worktrees/issue-123"), "aide");
    assert.equal(projectFromCwd("~/apps/aide"), "aide");
  });

  it("apps の下でなければ末尾の要素で代用する", () => {
    assert.equal(projectFromCwd("/srv/something/deep"), "deep");
    assert.equal(projectFromCwd(null), null);
  });
});

describe("remoteControlUrl", () => {
  it("接続先IDからURLを組み立てる", () => {
    assert.equal(
      remoteControlUrl("session_0187aY8hAAiBSbnFubsRNa3i"),
      "https://claude.ai/code/session_0187aY8hAAiBSbnFubsRNa3i",
    );
  });

  it("未確立なら null", () => {
    assert.equal(remoteControlUrl(undefined), null);
  });

  it("形が違う値はURLにしない（リンク先が別物になるため）", () => {
    assert.equal(remoteControlUrl("../../evil"), null);
    assert.equal(remoteControlUrl("session_abc/../x"), null);
  });
});

describe("toSession", () => {
  it("MCPへ出す粒度へ畳む", () => {
    const file: ClaudeSessionFile = {
      pid: 202000,
      cwd: "/home/guchi/apps/aide-worktrees/issue-123",
      startedAt: 1787217060223,
      tmux: "aide-issue-123:@85.%85",
      name: "aide #123",
      status: "busy",
      statusUpdatedAt: 1787217060510,
      bridgeSessionId: "session_0187aY8hAAiBSbnFubsRNa3i",
      version: "2.1.237",
    };

    assert.deepEqual(toSession(file, "/home/guchi"), {
      name: "aide #123",
      project: "aide",
      cwd: "~/apps/aide-worktrees/issue-123",
      tmuxSession: "aide-issue-123",
      startedAt: new Date(1787217060223).toISOString(),
      status: "busy",
      statusUpdatedAt: new Date(1787217060510).toISOString(),
      remoteControlUrl: "https://claude.ai/code/session_0187aY8hAAiBSbnFubsRNa3i",
      version: "2.1.237",
    });
  });

  it("statusUpdatedAt が無ければ updatedAt で代用する", () => {
    const session = toSession({ pid: 1, updatedAt: 1787217060510 }, "/home/guchi");
    assert.equal(session.statusUpdatedAt, new Date(1787217060510).toISOString());
    // 台帳がほとんど空でも落とさない。欠けたものは null で返す。
    assert.equal(session.remoteControlUrl, null);
    assert.equal(session.cwd, null);
  });
});

describe("collectClaudeCodeSessions", () => {
  let dir: string;
  const previous = process.env["AIDE_CLAUDE_SESSIONS_DIR"];

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "aide-claude-sessions-"));
    process.env["AIDE_CLAUDE_SESSIONS_DIR"] = dir;

    // 生きているセッションの代わりに、このテストプロセス自身を使う。
    const stat = await readFile(`/proc/${process.pid}/stat`, "utf8");
    await writeFile(
      join(dir, `${process.pid}.json`),
      JSON.stringify({
        pid: process.pid,
        procStart: parseProcStartTicks(stat),
        cwd: "/home/guchi/apps/aide",
        name: "alive",
        bridgeSessionId: "session_alive",
      }),
    );

    // 終了済みの残骸。PIDは存在しても起動時刻が違えば別プロセス。
    await writeFile(
      join(dir, `${process.pid}0.json`),
      JSON.stringify({ pid: process.pid, procStart: "0", name: "dead" }),
    );

    // 書き込みの途中を掴んだ台帳。1件の失敗で全体を落とさない。
    await writeFile(join(dir, "broken.json"), "{ not json");

    // 認証情報。**開かないこと自体を確かめる**ため、読めばJSONとして壊れる中身にしてある。
    await writeFile(join(dir, "1.abc.key"), "secret-material");
  });

  after(async () => {
    if (previous === undefined) delete process.env["AIDE_CLAUDE_SESSIONS_DIR"];
    else process.env["AIDE_CLAUDE_SESSIONS_DIR"] = previous;
    await rm(dir, { recursive: true, force: true });
  });

  it("生きているセッションだけを返し、.key は開かない", async () => {
    const snapshot = await collectClaudeCodeSessions();

    assert.deepEqual(
      snapshot.sessions.map((session) => session.name),
      ["alive"],
    );
    assert.equal(snapshot.sessions[0]?.remoteControlUrl, "https://claude.ai/code/session_alive");
    // 壊れた1件だけが数えられる（.key はそもそも読みに行かない）。
    assert.equal(snapshot.unreadable, 1);
    assert.ok(snapshot.hostname.length > 0);
  });

  it("ディレクトリが無ければ 0件（失敗にはしない）", async () => {
    process.env["AIDE_CLAUDE_SESSIONS_DIR"] = join(dir, "missing");
    try {
      const snapshot = await collectClaudeCodeSessions();
      assert.deepEqual(snapshot.sessions, []);
      assert.equal(snapshot.unreadable, 0);
    } finally {
      process.env["AIDE_CLAUDE_SESSIONS_DIR"] = dir;
    }
  });
});
