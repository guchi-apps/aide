import assert from "node:assert/strict";
import { test } from "node:test";
import { runSelfUpdate, type SelfUpdateOptions } from "./self-update.ts";

interface Call {
  file: string;
  args: string[];
}

function optionsFor(outputs: string[]): { options: SelfUpdateOptions; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    options: {
      setupScript: "/home/test/apps/subpc/setup.sh",
      execute: async (file, args) => {
        calls.push({ file, args });
        return { stdout: outputs.shift() ?? "", stderr: "" };
      },
    },
  };
}

test("追跡済みの変更があれば未追跡ファイルを除外して更新を見送る", async () => {
  const { options, calls } = optionsFor([" M src/server.ts\n"]);
  await assert.rejects(() => runSelfUpdate(options), /未コミット変更/);
  assert.deepEqual(calls, [
    { file: "git", args: ["status", "--porcelain", "--untracked-files=no"] },
  ]);
});

test("develop 以外のブランチは更新しない", async () => {
  const { options, calls } = optionsFor(["", "main\n"]);
  await assert.rejects(() => runSelfUpdate(options), /develop ではありません/);
  assert.equal(calls.length, 2);
});

test("差分が無ければ pull・npm ci・再起動をしない", async () => {
  const { options, calls } = optionsFor(["", "develop\n", "", "abc\n", "abc\n"]);
  const result = await runSelfUpdate(options);
  assert.deepEqual(result, { updated: false, before: "abc", after: "abc", dependenciesInstalled: false });
  assert.deepEqual(calls.map(({ file, args }) => [file, args]), [
    ["git", ["status", "--porcelain", "--untracked-files=no"]],
    ["git", ["branch", "--show-current"]],
    ["git", ["fetch", "origin", "develop"]],
    ["git", ["rev-parse", "HEAD"]],
    ["git", ["rev-parse", "origin/develop"]],
  ]);
});

test("更新後に package-lock.json が変わったときだけ依存を入れ、unitを反映して受け口を再起動する", async () => {
  const { options, calls } = optionsFor([
    "", "develop\n", "", "before\n", "after\n", "", "after\n", "package-lock.json\n", "", "", "",
  ]);
  const result = await runSelfUpdate(options);
  assert.deepEqual(result, { updated: true, before: "before", after: "after", dependenciesInstalled: true });
  assert.deepEqual(calls.slice(-3), [
    { file: "npm", args: ["ci"] },
    { file: "/home/test/apps/subpc/setup.sh", args: ["--only", "systemd"] },
    { file: "systemctl", args: ["--user", "restart", "aide-zaim-web.service"] },
  ]);
});

test("package-lock.json が変わらない更新では npm ci を呼ばない", async () => {
  const { options, calls } = optionsFor([
    "", "develop\n", "", "before\n", "after\n", "", "after\n", "src/server.ts\n", "", "",
  ]);
  const result = await runSelfUpdate(options);
  assert.equal(result.dependenciesInstalled, false);
  assert.ok(!calls.some(({ file, args }) => file === "npm" && args[0] === "ci"));
  assert.deepEqual(calls.slice(-2), [
    { file: "/home/test/apps/subpc/setup.sh", args: ["--only", "systemd"] },
    { file: "systemctl", args: ["--user", "restart", "aide-zaim-web.service"] },
  ]);
});
