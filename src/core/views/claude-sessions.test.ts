import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { STALE_AFTER_MINUTES, summarizeClaudeSessions } from "./claude-sessions.ts";
import type { CachedValue } from "../cache/store.ts";
import type { ClaudeCodeSession, ClaudeCodeSessionsSnapshot } from "../connectors/claude-code/types.ts";

/** `summarizeClaudeSessions` は純粋関数なので、テストはここに集中させる。 */

const NOW = new Date("2026-08-20T12:00:00.000Z");

function session(overrides: Partial<ClaudeCodeSession> = {}): ClaudeCodeSession {
  return {
    name: "aide #123",
    project: "aide",
    cwd: "~/apps/aide-worktrees/issue-123",
    tmuxSession: "aide-issue-123",
    startedAt: "2026-08-20T09:00:00.000Z",
    status: "busy",
    statusUpdatedAt: "2026-08-20T11:30:00.000Z",
    remoteControlUrl: "https://claude.ai/code/session_0187aY8hAAiBSbnFubsRNa3i",
    version: "2.1.237",
    ...overrides,
  };
}

function cached(
  overrides: Partial<ClaudeCodeSessionsSnapshot> = {},
  ageMinutes = 1,
): CachedValue<ClaudeCodeSessionsSnapshot> {
  const collectedAt = new Date(NOW.getTime() - ageMinutes * 60_000).toISOString();
  return {
    source: "claude-code",
    fetchedAt: collectedAt,
    ageMinutes,
    data: { hostname: "subpc", collectedAt, sessions: [session()], unreadable: 0, ...overrides },
  };
}

describe("summarizeClaudeSessions", () => {
  it("セッションごとに経過時間を添えて返す", () => {
    const view = summarizeClaudeSessions(cached(), NOW);

    assert.equal(view.ok, true);
    assert.equal(view.stale, false);
    assert.equal(view.hostname, "subpc");
    assert.equal(view.snapshotAgeMinutes, 1);
    assert.equal(view.sessions.length, 1);
    // 起動から3時間、いまの状態になってから30分。
    assert.equal(view.sessions[0]?.runningForMinutes, 180);
    assert.equal(view.sessions[0]?.statusForMinutes, 30);
    assert.equal(
      view.sessions[0]?.remoteControlUrl,
      "https://claude.ai/code/session_0187aY8hAAiBSbnFubsRNa3i",
    );
    // 「いつ時点か」を必ず添える。スナップショットである以上、これが無いと答えが誤解される。
    assert.match(view.note, /1分前/);
  });

  it("まだ1件も届いていなければ ok を false にする（セッションが無いという意味ではない）", () => {
    const view = summarizeClaudeSessions(null, NOW);

    assert.equal(view.ok, false);
    assert.equal(view.stale, true);
    assert.deepEqual(view.sessions, []);
    assert.equal(view.collectedAt, null);
    assert.match(view.note, /claude-sessions-sync/);
  });

  it("収集が止まっていれば stale にして、いまの状態として扱わせない", () => {
    const view = summarizeClaudeSessions(cached({}, STALE_AFTER_MINUTES + 1), NOW);

    assert.equal(view.stale, true);
    assert.equal(view.ok, false);
    // 一覧そのものは残す。中身が消えると「何が動いていたか」まで分からなくなる。
    assert.equal(view.sessions.length, 1);
    assert.match(view.note, /既に終了している可能性/);
  });

  it("キャッシュの受信時刻ではなく、サブPCが集めた時刻で鮮度を測る", () => {
    // 送信が詰まると受信時刻（ageMinutes）だけが新しくなる。それを鮮度にすると古さを見逃す。
    const stale = cached({}, STALE_AFTER_MINUTES + 5);
    const view = summarizeClaudeSessions({ ...stale, ageMinutes: 0 }, NOW);

    assert.equal(view.snapshotAgeMinutes, STALE_AFTER_MINUTES + 5);
    assert.equal(view.stale, true);
  });

  it("リモートコントロールが未確立のセッションがあれば断り書きを添える", () => {
    const view = summarizeClaudeSessions(cached({ sessions: [session({ remoteControlUrl: null })] }), NOW);

    assert.match(view.note, /remoteControlUrl が null/);
  });

  it("0件なら「動いていない」と言い切る", () => {
    const view = summarizeClaudeSessions(cached({ sessions: [] }), NOW);

    assert.equal(view.ok, true);
    assert.match(view.note, /セッションは無い/);
  });

  it("読めなかった台帳の件数を隠さない", () => {
    const view = summarizeClaudeSessions(cached({ unreadable: 2 }), NOW);

    assert.match(view.note, /2件/);
  });
});
