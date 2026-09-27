import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { notifySelfUpdateSuccess } from "../notify.ts";

const execFileAsync = promisify(execFile);

export interface SelfUpdateResult {
  updated: boolean;
  before: string;
  after: string;
  dependenciesInstalled: boolean;
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
 */
export async function runSelfUpdate(options: SelfUpdateOptions = {}): Promise<SelfUpdateResult> {
  const cwd = options.cwd ?? process.cwd();
  const setupScript = options.setupScript ?? `${homedir()}/apps/subpc/setup.sh`;
  const execute = options.execute ?? defaultExecute(cwd);

  const dirty = await output(execute, "git", ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty) throw new Error("追跡済みの未コミット変更があるため更新を見送ります");

  const branch = await output(execute, "git", ["branch", "--show-current"]);
  if (branch !== "develop") {
    throw new Error(`追跡ブランチが develop ではありません（現在: ${branch || "detached HEAD"}）`);
  }

  await execute("git", ["fetch", "origin", "develop"]);
  const before = await output(execute, "git", ["rev-parse", "HEAD"]);
  const remote = await output(execute, "git", ["rev-parse", "origin/develop"]);
  if (before === remote) {
    return { updated: false, before, after: before, dependenciesInstalled: false };
  }

  await execute("git", ["pull", "--ff-only", "origin", "develop"]);
  const after = await output(execute, "git", ["rev-parse", "HEAD"]);
  const changed = await output(execute, "git", ["diff", "--name-only", before, after, "--", "package-lock.json"]);
  const dependenciesInstalled = changed.split("\n").includes("package-lock.json");
  if (dependenciesInstalled) await execute("npm", ["ci"]);

  // unit の配置と daemon-reload は配布元である subpc が一元管理する。
  await execute(setupScript, ["--only", "systemd"]);
  await execute("systemctl", ["--user", "restart", "aide-zaim-web.service"]);
  await notifySelfUpdateSuccess({ before, after, dependenciesInstalled });

  return { updated: true, before, after, dependenciesInstalled };
}
