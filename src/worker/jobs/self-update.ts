import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SelfUpdateResult {
  updated: boolean;
  before: string;
  after: string;
  dependenciesInstalled: boolean;
  /**
   * develop 以外に置き去りにされていたチェックアウトを develop へ戻したときの、元のブランチ名
   * （detached HEAD なら "detached HEAD"）。戻していなければ null（#807）。
   */
  returnedFrom: string | null;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

type Execute = (file: string, args: string[]) => Promise<CommandResult>;

export interface SelfUpdateOptions {
  /** テスト用。通常は process.cwd()、unit は ~/apps/aide から起動する。 */
  cwd?: string;
  /** テスト用。通常は ~/apps/subpc/setup.sh。 */
  setupScript?: string;
  execute?: Execute;
}

function defaultExecute(cwd: string): Execute {
  return async (file, args) => {
    const result = await execFileAsync(file, args, { cwd });
    return { stdout: result.stdout, stderr: result.stderr };
  };
}

async function output(execute: Execute, file: string, args: string[]): Promise<string> {
  return (await execute(file, args)).stdout.trim();
}

/**
 * サブPCの aide チェックアウトを origin/develop へ fast-forward する。
 *
 * 更新対象を develop に固定し、追跡済みの未コミット変更があれば何も書き換えない。
 * 未追跡ファイルは実機に常設のメモがあるため、この判定から除く。
 *
 * 本体チェックアウトが develop 以外（作業ブランチ・detached HEAD）に置き去りにされていても、
 * その HEAD が origin/develop に取り込み済みなら develop へ戻して続行する（#807）。
 * 取り込み済みなら develop へ戻しても失われるコミットが無いため。取り込まれていないコミットが
 * ある場合だけ、従来どおり失敗として止めて人に判断を委ねる。
 */
export async function runSelfUpdate(options: SelfUpdateOptions = {}): Promise<SelfUpdateResult> {
  const cwd = options.cwd ?? process.cwd();
  const setupScript = options.setupScript ?? `${homedir()}/apps/subpc/setup.sh`;
  const execute = options.execute ?? defaultExecute(cwd);

  const dirty = await output(execute, "git", ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty) throw new Error("追跡済みの未コミット変更があるため更新を見送ります");

  const branch = await output(execute, "git", ["branch", "--show-current"]);
  await execute("git", ["fetch", "origin", "develop"]);

  let returnedFrom: string | null = null;
  if (branch !== "develop") {
    const current = branch || "detached HEAD";
    if (!(await isAncestorOfRemoteDevelop(execute, "HEAD"))) {
      throw new Error(
        `追跡ブランチが develop ではなく、origin/develop に未取り込みのコミットがあるため更新を見送ります（現在: ${current}）`,
      );
    }
    // 戻り先のローカル develop が origin/develop に未取り込みのコミットを持つなら、
    // 切り替えて setup・再起動まで進むと未レビューのコミットが稼働する。切り替える前に止める。
    if (!(await isAncestorOfRemoteDevelop(execute, "develop"))) {
      throw new Error(
        `復帰先のローカル develop に origin/develop へ未取り込みのコミットがあるため、切り替えと再起動を見送ります（現在: ${current}）`,
      );
    }
    await execute("git", ["switch", "develop"]);
    returnedFrom = current;
  }

  const before = await output(execute, "git", ["rev-parse", "HEAD"]);
  const remote = await output(execute, "git", ["rev-parse", "origin/develop"]);
  if (before === remote) {
    return { updated: false, before, after: before, dependenciesInstalled: false, returnedFrom };
  }

  await execute("git", ["pull", "--ff-only", "origin", "develop"]);
  const after = await output(execute, "git", ["rev-parse", "HEAD"]);
  const changed = await output(execute, "git", ["diff", "--name-only", before, after, "--", "package-lock.json"]);
  const dependenciesInstalled = changed.split("\n").includes("package-lock.json");
  if (dependenciesInstalled) await execute("npm", ["ci"]);

  // unit の配置と daemon-reload は配布元である subpc が一元管理する。
  await execute(setupScript, ["--only", "systemd"]);
  await execute("systemctl", ["--user", "restart", "aide-zaim-web.service"]);

  return { updated: true, before, after, dependenciesInstalled, returnedFrom };
}

/**
 * ref が origin/develop の祖先または同一（＝取り込み済み）かを返す。
 *
 * `git merge-base --is-ancestor` は「祖先でない」を終了コード1で表し、execFile はそれを例外にする。
 * 終了コード1だけを「未取り込み」とみなし、それ以外の失敗（リポジトリ破損など）はそのまま投げる。
 */
async function isAncestorOfRemoteDevelop(execute: Execute, ref: string): Promise<boolean> {
  try {
    await execute("git", ["merge-base", "--is-ancestor", ref, "origin/develop"]);
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return false;
    throw error;
  }
}
