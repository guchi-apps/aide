import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  ZAIM_SCREEN_FILE_LOCK_MAX_AGE_MS,
  acquireZaimScreenFileLockWaiting,
  tryAcquireZaimScreenFileLock,
} from "./screen-file-lock.ts";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "aide-zaim-screen-lock-"));
  path = join(dir, "nested", "screen.lock");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("Zaim画面のファイルロック", () => {
  it("取れたら他は取れず、解放すれば取れる", async () => {
    const first = await tryAcquireZaimScreenFileLock(Date.now, path);
    assert.ok(first);
    assert.equal(await tryAcquireZaimScreenFileLock(Date.now, path), null);
    await first.release();
    const again = await tryAcquireZaimScreenFileLock(Date.now, path);
    assert.ok(again);
    await again.release();
  });

  it("ロックにはpidと時刻しか書かない", async () => {
    const lock = await tryAcquireZaimScreenFileLock(() => 1234, path);
    const body = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    assert.deepEqual(body, { pid: process.pid, acquiredAt: 1234 });
    await lock?.release();
  });

  it("持ち主のプロセスが居ないロックは奪う", async () => {
    await tryAcquireZaimScreenFileLock(Date.now, path).then((l) => l?.release());
    // 存在しないpid（pid上限を超える値）。
    await writeFile(path, JSON.stringify({ pid: 2 ** 31 - 2, acquiredAt: Date.now() }));
    const lock = await tryAcquireZaimScreenFileLock(Date.now, path);
    assert.ok(lock);
    await lock.release();
  });

  it("上限時間を超えたロックは、持ち主が生きていても奪う", async () => {
    const held = await tryAcquireZaimScreenFileLock(() => 0, path);
    assert.ok(held);
    assert.equal(await tryAcquireZaimScreenFileLock(() => ZAIM_SCREEN_FILE_LOCK_MAX_AGE_MS, path), null);
    const stolen = await tryAcquireZaimScreenFileLock(() => ZAIM_SCREEN_FILE_LOCK_MAX_AGE_MS + 1, path);
    assert.ok(stolen);
    await stolen.release();
  });

  it("奪われた後に古い持ち主が解放しても、新しいロックは消えない", async () => {
    const old = await tryAcquireZaimScreenFileLock(() => 0, path);
    await writeFile(path, JSON.stringify({ pid: process.pid + 1, acquiredAt: Date.now() }));
    await old?.release();
    assert.match(await readFile(path, "utf8"), /acquiredAt/);
  });

  it("待つ版は、解放されれば取れ、上限まで待って取れなければ null", async () => {
    const held = await tryAcquireZaimScreenFileLock(Date.now, path);
    assert.ok(held);

    let clock = 0;
    const giveUp = await acquireZaimScreenFileLockWaiting({
      path,
      timeoutMs: 30,
      pollMs: 10,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    assert.equal(giveUp, null);

    let polls = 0;
    const waited = await acquireZaimScreenFileLockWaiting({
      path,
      timeoutMs: 1000,
      pollMs: 1,
      sleep: async () => {
        polls += 1;
        if (polls === 2) await held.release();
      },
    });
    assert.ok(waited);
    await waited.release();
  });
});
