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

test("develop 以外のブランチに origin/develop へ未取り込みのコミットがあれば戻さずに更新を見送る", async () => {
  const calls: Call[] = [];
  const outputs = ["", "issue-771-mail-charset\n", ""];
  const options: SelfUpdateOptions = {
    setupScript: "/home/test/apps/subpc/setup.sh",
    execute: async (file, args) => {
      calls.push({ file, args });
      if (args[0] === "merge-base") throw Object.assign(new Error("not ancestor"), { code: 1 });
      return { stdout: outputs.shift() ?? "", stderr: "" };
    },
  };
  await assert.rejects(() => runSelfUpdate(options), /未取り込みのコミット.*issue-771-mail-charset/);
  assert.deepEqual(calls.map(({ args }) => args), [
    ["status", "--porcelain", "--untracked-files=no"],
    ["branch", "--show-current"],
    ["fetch", "origin", "develop"],
    ["merge-base", "--is-ancestor", "HEAD", "origin/develop"],
  ]);
});

test("復帰先のローカル develop が origin/develop より先行していれば、切り替えも再起動もせず更新を見送る", async () => {
  const calls: Call[] = [];
  const outputs = ["", "issue-771\n", ""];
  const options: SelfUpdateOptions = {
    setupScript: "/home/test/apps/subpc/setup.sh",
    execute: async (file, args) => {
      calls.push({ file, args });
      if (args[0] === "merge-base" && args[2] === "develop") {
        throw Object.assign(new Error("not ancestor"), { code: 1 });
      }
      return { stdout: outputs.shift() ?? "", stderr: "" };
    },
  };
  await assert.rejects(() => runSelfUpdate(options), /ローカル develop.*未取り込みのコミット.*issue-771/);
  assert.ok(!calls.some(({ args }) => args[0] === "switch" || args[0] === "pull"));
  assert.ok(!calls.some(({ file }) => file === "systemctl"));
});

test("取り込み済みか判定できない git の失敗は、未取り込みと取り違えずにそのまま投げる", async () => {
  const options: SelfUpdateOptions = {
    execute: async (_file, args) => {
      if (args[0] === "merge-base") throw Object.assign(new Error("fatal: bad object"), { code: 128 });
      return { stdout: args[0] === "branch" ? "main\n" : "", stderr: "" };
    },
  };
  await assert.rejects(() => runSelfUpdate(options), /bad object/);
});

test("origin/develop に取り込み済みのブランチに置き去りなら develop へ戻して更新を続ける", async () => {
  const { options, calls } = optionsFor([
    "", "issue-771\n", "", "", "", "", "before\n", "after\n", "", "after\n", "src/server.ts\n", "", "",
  ]);
  const result = await runSelfUpdate(options);
  assert.deepEqual(result, {
    updated: true, before: "before", after: "after", dependenciesInstalled: false, returnedFrom: "issue-771",
  });
  assert.deepEqual(calls.slice(2, 7).map(({ args }) => args), [
    ["fetch", "origin", "develop"],
    ["merge-base", "--is-ancestor", "HEAD", "origin/develop"],
    ["merge-base", "--is-ancestor", "develop", "origin/develop"],
    ["switch", "develop"],
    ["rev-parse", "HEAD"],
  ]);
});

test("detached HEAD でも取り込み済みなら develop へ戻し、差分が無ければそこで終える", async () => {
  const { options, calls } = optionsFor(["", "\n", "", "", "", "", "abc\n", "abc\n"]);
  const result = await runSelfUpdate(options);
  assert.deepEqual(result, {
    updated: false, before: "abc", after: "abc", dependenciesInstalled: false, returnedFrom: "detached HEAD",
  });
  assert.ok(calls.some(({ args }) => args[0] === "switch" && args[1] === "develop"));
  assert.ok(!calls.some(({ args }) => args[0] === "pull"));
});

test("差分が無ければ pull・npm ci・再起動をしない", async () => {
  const { options, calls } = optionsFor(["", "develop\n", "", "abc\n", "abc\n"]);
  const result = await runSelfUpdate(options);
  assert.deepEqual(result, { updated: false, before: "abc", after: "abc", dependenciesInstalled: false, returnedFrom: null });
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
  assert.deepEqual(result, { updated: true, before: "before", after: "after", dependenciesInstalled: true, returnedFrom: null });
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
