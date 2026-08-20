import { readCache, type CachedValue } from "../cache/store.ts";
import type { ClaudeCodeSession, ClaudeCodeSessionsSnapshot } from "../connectors/claude-code/types.ts";
import { CLAUDE_SESSIONS_CACHE_KEY } from "../../worker/jobs/claude-sessions-sync.ts";

/**
 * サブPCで動いている Claude Code セッションのビュー。
 *
 * 台帳を持っているのはサブPCで、MCPサーバーはVPSで動く。呼ばれたときに読みに行けないため、
 * **worker が2分ごとに送ってきたスナップショットを読む**（`claude-sessions-sync`）。
 * 他のビューと違い、答えそのものが「いつ時点か」に強く依存するので、収集時刻と経過分数を
 * 必ず添えて返す。
 *
 * 返すのは「どのセッションが動いていて、どこへ飛べばよいか」に答えられる粒度まで。
 * 会話の中身・実行したツール・トークン使用量は**返さない**（台帳にも入っていない）。
 */

/**
 * これを超えて更新されていなければ、一覧を「いま動いているもの」として扱わない。
 *
 * 収集は2分ごと（`JOB_CATALOG` の `claude-sessions-sync`）。5回ぶん飛べば、
 * 一覧に載っているセッションが既に終わっている可能性の方が高くなる。
 */
export const STALE_AFTER_MINUTES = 10;

export interface ClaudeSessionSummary extends ClaudeCodeSession {
  /** 起動からの経過分数。 */
  runningForMinutes: number | null;
  /** いまの状態（busy / idle）になってからの経過分数。放置セッションの判断に使う。 */
  statusForMinutes: number | null;
}

export interface ClaudeSessionsStatus {
  /** この答えを組み立てた時刻。**セッションを収集した時刻ではない。** */
  checkedAt: string;
  /** 収集したホスト名。まだ1件も届いていなければ null。 */
  hostname: string | null;
  /** 収集時刻（ISO8601）。 */
  collectedAt: string | null;
  /** 収集からの経過分数。 */
  snapshotAgeMinutes: number | null;
  /** 一覧を「いまの状態」として扱えるか。届いていない・古すぎる場合は false。 */
  ok: boolean;
  /** 収集が止まっているか。 */
  stale: boolean;
  sessions: ClaudeSessionSummary[];
  note: string;
}

function minutesSince(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const ms = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round(ms / 60_000));
}

/** キャッシュがまだ1件も無いときの答え。 */
function notCollected(now: Date): ClaudeSessionsStatus {
  return {
    checkedAt: now.toISOString(),
    hostname: null,
    collectedAt: null,
    snapshotAgeMinutes: null,
    ok: false,
    stale: true,
    sessions: [],
    note:
      "セッションの一覧がまだ1件も届いていない。サブPC側の claude-sessions-sync が" +
      "動いていない可能性がある（セッションが動いていないという意味ではない）。",
  };
}

/** スナップショットを畳む。**純粋関数。テストはここに集中する。** */
export function summarizeClaudeSessions(
  cached: CachedValue<ClaudeCodeSessionsSnapshot> | null,
  now: Date,
): ClaudeSessionsStatus {
  if (!cached) return notCollected(now);

  const snapshot = cached.data;
  // 収集時刻は worker（サブPC）が打つ。キャッシュの `fetchedAt` はVPSが受け取った時刻で、
  // 送信が詰まっていると実際より新しく見えるため、あるなら収集時刻の方を使う。
  const collectedAt = snapshot.collectedAt ?? null;
  const snapshotAgeMinutes = minutesSince(collectedAt, now) ?? cached.ageMinutes;
  const stale = snapshotAgeMinutes > STALE_AFTER_MINUTES;

  const sessions = (snapshot.sessions ?? []).map((session) => ({
    ...session,
    runningForMinutes: minutesSince(session.startedAt, now),
    statusForMinutes: minutesSince(session.statusUpdatedAt, now),
  }));

  const notes = [
    `${snapshotAgeMinutes}分前に${snapshot.hostname ?? "サブPC"}で集めた一覧。` +
      "収集は2分ごとなので、直前に始めた・終えたセッションは反映されていないことがある。",
  ];
  if (stale) {
    notes.push(
      `収集が${STALE_AFTER_MINUTES}分以上止まっている。` +
        "一覧のセッションは既に終了している可能性があるため、いまの状態として扱わないこと。",
    );
  }
  if (!stale && sessions.length === 0) {
    notes.push("サブPCで動いている Claude Code のセッションは無い。");
  }
  if (sessions.some((session) => session.remoteControlUrl === null)) {
    notes.push(
      "remoteControlUrl が null のセッションはリモートコントロールが確立しておらず、" +
        "URLからは開けない（tmuxSession の名前で端末から attach する）。",
    );
  }
  const waiting = sessions.filter((session) => session.status === "waiting");
  if (waiting.length > 0) {
    // **Issueが求めた「放置セッションの判断」に直接答えるのはここ。**
    // busy/idle だけを見ると、人の返事を待って止まっているセッションが idle に紛れる。
    notes.push(
      `${waiting.length}件が人の入力を待っている（status が waiting。waitingFor に理由、` +
        "statusForMinutes が待っている分数）。",
    );
  }
  if (snapshot.unreadable > 0) {
    notes.push(`読み取れなかった台帳が ${snapshot.unreadable}件あり、その分は一覧に含まれない。`);
  }
  if (snapshot.nonInteractive > 0) {
    notes.push(
      `SDK経由の裏方プロセスが ${snapshot.nonInteractive}件あり、一覧から除いてある` +
        "（人が開いて操作する対象ではないため）。",
    );
  }

  return {
    checkedAt: now.toISOString(),
    hostname: snapshot.hostname ?? null,
    collectedAt,
    snapshotAgeMinutes,
    ok: !stale,
    stale,
    sessions,
    note: notes.join(" "),
  };
}

/** MCPツールから呼ばれる入口。キャッシュを読み、畳む。 */
export async function buildClaudeSessionsStatus(): Promise<ClaudeSessionsStatus> {
  const cached = await readCache<ClaudeCodeSessionsSnapshot>(CLAUDE_SESSIONS_CACHE_KEY);
  return summarizeClaudeSessions(cached, new Date());
}
