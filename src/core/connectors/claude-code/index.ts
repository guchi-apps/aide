import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  ClaudeCodeSession,
  ClaudeCodeSessionsSnapshot,
  ClaudeSessionFile,
} from "./types.ts";

const execFileAsync = promisify(execFile);

/**
 * Claude Code コネクタ。
 *
 * **外部サービスではなく、同じマシンのファイルを読むだけ**という点で他のコネクタと違う。
 * それでもコネクタに置いているのは、読む対象（Claude Code 本体が書く台帳）の形をAIDEが
 * 決められない――つまり「外部の都合で変わるものの取得」という役割が同じであるため。
 *
 * Claude Code はセッションごとに `~/.claude/sessions/<pid>.json` を書き、そこに作業ディレクトリ・
 * tmuxセッション名・busy/idle と、リモートコントロールの接続先ID（`bridgeSessionId`）を持つ。
 * ここを読めば「サブPCでいま何が動いているか」と、そこへ飛ぶURLが分かる。
 *
 * **読むのはサブPC（worker）だけ。** MCPサーバーはVPSで動くのでこのディレクトリを持たない。
 * 収集結果は既存の `POST /api/cache/:key` の経路でサーバーへ渡す（README「worker とサーバーが
 * 別マシンである問題」）。
 */

/** リモートコントロールの画面。`bridgeSessionId` を足すとセッションのURLになる。 */
const REMOTE_CONTROL_BASE_URL = "https://claude.ai/code/";

/**
 * リモートコントロールの接続先IDとして受け入れる形。
 *
 * **URLの一部になるため、形を確かめてから組み立てる。** 台帳の中身はAIDEが書いたものではなく、
 * 想定外の文字が入ったままURLにすると、リンク先がClaudeのセッションとは限らなくなる。
 */
const BRIDGE_SESSION_ID_PATTERN = /^session_[A-Za-z0-9_-]{1,64}$/;

/**
 * 台帳の置き場。
 * テストが本物の `~/.claude` を読まずに済むよう、環境変数で差し替えられるようにしている。
 */
export function sessionsDir(): string {
  const override = process.env["AIDE_CLAUDE_SESSIONS_DIR"];
  return override ? resolve(override) : join(homedir(), ".claude", "sessions");
}

/**
 * `/proc/<pid>/stat` から starttime（22番目のフィールド）を取り出す。
 *
 * **前から数えて22番目を取ってはいけない。** 2番目のフィールドはプロセス名が括弧で囲まれた
 * もので、名前自体に空白や括弧を含められる。閉じ括弧の**最後**の出現より後ろだけを数える。
 */
export function parseProcStartTicks(stat: string): string | null {
  const tail = stat.slice(stat.lastIndexOf(")") + 1).trim();
  if (tail === "") return null;
  // 閉じ括弧の後ろは3番目のフィールド（state）から始まるので、starttime は 20 番目にあたる。
  const fields = tail.split(/\s+/);
  return fields[19] ?? null;
}

/**
 * プロセスの起動時刻を OS ごとの方法で取る。無ければ（＝そのPIDのプロセスが無ければ）null。
 *
 * - Linux: `/proc/<pid>/stat` の starttime（clock ticks）
 * - macOS: `ps -o lstart=`。**台帳の `procStart` はUTCで書かれている**ので、`TZ=UTC` で揃える
 *   （Mac mini の実物で、ローカル時刻とは9時間ずれることを確認済み）
 */
export type ProcessStartReader = (pid: number) => Promise<string | null>;

export const readProcessStart: ProcessStartReader = async (pid) => {
  if (process.platform === "linux") {
    try {
      return parseProcStartTicks(await readFile(`/proc/${pid}/stat`, "utf8")) ?? "";
    } catch {
      return null;
    }
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], {
      env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
    });
    const value = stdout.trim().replace(/\s+/g, " ");
    return value === "" ? null : value;
  } catch {
    // ps は該当プロセスが無いと終了コード1で落ちる。
    return null;
  }
};

/** `ps` の lstart 形式（`Sat Nov 21 05:15:51 2026`）をUTCのエポックミリ秒にする。 */
function lstartToEpoch(value: string): number | null {
  if (/^\d+$/.test(value)) return null;
  const epoch = Date.parse(`${value.replace(/\s+/g, " ")} UTC`);
  return Number.isNaN(epoch) ? null : epoch;
}

/**
 * 台帳の `procStart` と実プロセスの起動時刻が同じプロセスを指すか。
 *
 * 形式が噛み合わない場合（Linuxのticksを台帳が持つのにmacOSで読む等）は照合できないので、
 * PIDが生きていること自体を根拠にする（true）。
 */
export function procStartMatches(recorded: string, actual: string): boolean {
  if (recorded === actual) return true;
  const a = lstartToEpoch(recorded);
  const b = lstartToEpoch(actual);
  if (a !== null && b !== null) return a === b;
  // 片方が ticks・片方が lstart のように別形式なら照合不能。
  const comparable = (a === null) === (b === null);
  return !comparable;
}

/**
 * そのセッションのプロセスがまだ生きているか。
 *
 * **PIDの一致だけでは足りない。** 台帳は終了時に消えるとは限らず、残骸のPIDが別のプロセスへ
 * 割り当て直されていることがある。台帳が `procStart` を持っているのはこのためで、
 * プロセスの起動時刻まで一致して初めて「同じプロセス」と言える。
 * `readStart` はテストで差し替えるための口（`/proc` の無い環境でも検証できるようにする）。
 */
export async function isSessionAlive(
  pid: number,
  procStart: string | undefined,
  readStart: ProcessStartReader = readProcessStart,
): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  const actual = await readStart(pid);
  if (actual === null) return false;

  // 起動時刻を書いていない世代の台帳では、PIDが存在することだけを根拠にする。
  if (!procStart) return true;
  return procStartMatches(procStart, actual);
}

/** `<セッション名>:@<window>.<pane>` からtmuxのセッション名だけを取り出す。 */
export function tmuxSessionName(tmux: string | undefined): string | null {
  if (!tmux) return null;
  const name = tmux.split(":")[0]?.trim();
  return name ? name : null;
}

/** ホームディレクトリを `~` に置き換える。生のパスをそのまま外へ出さないため。 */
export function shortenHome(path: string | undefined, home: string): string | null {
  if (!path) return null;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/**
 * 作業ディレクトリからプロジェクト名を導く。
 *
 * `~/apps/<プロジェクト>` と `~/apps/<プロジェクト>-worktrees/<ブランチ>` の2つが実際の形。
 * worktree 側も同じプロジェクトとして畳まないと、複数セッションを見分けるときに
 * 「どのリポジトリの作業か」が読めなくなる。当てはまらないパスは末尾の要素で代用する。
 */
export function projectFromCwd(cwd: string | null): string | null {
  if (!cwd) return null;
  const parts = cwd.split("/").filter((part) => part !== "" && part !== "~" && part !== ".");
  if (parts.length === 0) return null;

  const appsIndex = parts.lastIndexOf("apps");
  const candidate = appsIndex >= 0 ? parts[appsIndex + 1] : undefined;
  const name = candidate ?? parts[parts.length - 1];
  if (!name) return null;

  return name.endsWith("-worktrees") ? name.slice(0, -"-worktrees".length) : name;
}

/** リモートコントロールのURL。接続先IDが無い・形が違う場合は null（＝未確立）。 */
export function remoteControlUrl(bridgeSessionId: string | undefined): string | null {
  if (!bridgeSessionId || !BRIDGE_SESSION_ID_PATTERN.test(bridgeSessionId)) return null;
  return `${REMOTE_CONTROL_BASE_URL}${bridgeSessionId}`;
}

function toIso(epochMs: number | undefined): string | null {
  if (typeof epochMs !== "number" || !Number.isFinite(epochMs) || epochMs <= 0) return null;
  return new Date(epochMs).toISOString();
}

function text(value: string | undefined): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** 台帳1件を、MCPへ出してよい粒度へ畳む。**純粋関数。テストはここに集中する。** */
export function toSession(file: ClaudeSessionFile, home: string): ClaudeCodeSession {
  const cwd = shortenHome(file.cwd, home);
  return {
    name: text(file.name),
    project: projectFromCwd(cwd),
    cwd,
    tmuxSession: tmuxSessionName(file.tmux),
    startedAt: toIso(file.startedAt),
    status: text(file.status),
    waitingFor: text(file.waitingFor),
    statusUpdatedAt: toIso(file.statusUpdatedAt ?? file.updatedAt),
    remoteControlUrl: remoteControlUrl(file.bridgeSessionId),
    version: text(file.version),
  };
}

/**
 * 台帳を読み、生きているセッションだけを集める。
 *
 * ディレクトリごと無い場合（Claude Code を使っていないホスト）は 0件として返す。
 * **「取得に失敗した」ではなく「動いていない」**であり、失敗にすると worker が毎回落ちる。
 */
export async function collectClaudeCodeSessions(
  readStart: ProcessStartReader = readProcessStart,
): Promise<ClaudeCodeSessionsSnapshot> {
  const dir = sessionsDir();
  const home = homedir();

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    entries = [];
  }

  const sessions: ClaudeCodeSession[] = [];
  let unreadable = 0;
  let nonInteractive = 0;

  await Promise.all(
    // `.key` は認証情報なので触らない（`types.ts` 参照）。
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map(async (entry) => {
        let file: ClaudeSessionFile;
        try {
          file = JSON.parse(await readFile(join(dir, entry), "utf8")) as ClaudeSessionFile;
        } catch {
          // 書き込みの途中を掴むと壊れたJSONになる。1件の失敗で全体を落とさない。
          unreadable += 1;
          return;
        }
        if (typeof file.pid !== "number") return;
        if (!(await isSessionAlive(file.pid, file.procStart, readStart))) return;
        // SDK経由の裏方プロセス（`kind` が `interactive` でないもの）は、人が開いて操作する
        // 対象ではない。台帳には並ぶが、リモートコントロールもtmuxでのattachもできず、
        // 一覧に混ぜると「何件動いているか」がずれる。件数だけ数えて本体からは外す。
        // **`kind` を書かない世代の台帳は落とさない**（欠けているだけで裏方とは限らない）。
        if (file.kind !== undefined && file.kind !== "interactive") {
          nonInteractive += 1;
          return;
        }
        sessions.push(toSession(file, home));
      }),
  );

  // 新しく始めたセッションほど探している対象になりやすいので、起動が新しい順に並べる。
  sessions.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));

  return {
    hostname: hostname(),
    collectedAt: new Date().toISOString(),
    sessions,
    unreadable,
    nonInteractive,
  };
}
