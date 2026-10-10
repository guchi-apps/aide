import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { readPackageVersion } from "./version.ts";
import { REPO_ROOT } from "./paths.ts";

const dir = await mkdtemp(join(tmpdir(), "aide-version-test-"));
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function dist(name: string, body: string): Promise<string> {
  const root = join(dir, name);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), body);
  return root;
}

describe("readPackageVersion", () => {
  it("リポジトリ自身の package.json の version と一致する", async () => {
    const expected = (JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8")) as { version: string })
      .version;
    assert.equal(readPackageVersion(), expected);
  });

  it("配布物が変われば返す版も変わる（MCP側に固定値を持たない）", async () => {
    assert.equal(readPackageVersion(await dist("a", '{"version":"9.8.7"}')), "9.8.7");
    assert.equal(readPackageVersion(await dist("b", '{"version":"1.2.3"}')), "1.2.3");
  });

  it("別の作業ディレクトリでも同じ値を返す", () => {
    const before = process.cwd();
    const expected = readPackageVersion();
    try {
      process.chdir(dir);
      assert.equal(readPackageVersion(), expected);
    } finally {
      process.chdir(before);
    }
  });

  it("ファイルが無ければ、パス入りの例外にする", () => {
    assert.throws(() => readPackageVersion(join(dir, "none")), /package\.json を読めません/);
  });

  it("JSONが壊れていれば、例外にする", async () => {
    const root = await dist("bad", "{");
    assert.throws(() => readPackageVersion(root), /JSONとして不正/);
  });

  it("version が無ければ、推測せず例外にする", async () => {
    const root = await dist("nov", "{}");
    assert.throws(() => readPackageVersion(root), /version がありません/);
  });
});
