#!/usr/bin/env node
// iOSアプリ本体の入れ直しが要る変更（ios/ の配布物への実質的な差分）があるかを判定する（#525）。
//
//   node ios/scripts/ios-changes.mjs --base <ref> [--head <ref>] [--json]
//
// 配布物に入るのは AIDEios/・AIDEiosWidget/・AIDEios.xcodeproj/・AIDEios-Info.plist だけ。
// README・scripts は入らないので除外し、pbxproj の版番号の行（MARKETING_VERSION・
// CURRENT_PROJECT_VERSION）だけの差分も数えない（リリースのバンプで毎回書き換わるため）。

import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// pathspec（git diff に渡す）。配布物側だけを含め、Markdown は外す。
export const DISTRIBUTED_PATHSPEC = [
  "ios/AIDEios",
  "ios/AIDEiosWidget",
  "ios/AIDEios.xcodeproj",
  "ios/AIDEios-Info.plist",
  ":(exclude,glob)**/*.md",
];

const VERSION_LINE = /^[+-][\t ]*(MARKETING_VERSION|CURRENT_PROJECT_VERSION) = [^;]+;[\t ]*$/;

/** `git diff -U0` の出力から、配布物に影響する変更行だけを返す（純関数）。 */
export function meaningfulChangeLines(diffText) {
  return diffText
    .split("\n")
    .filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line))
    .filter((line) => !VERSION_LINE.test(line));
}

/** 意味のある変更行を持つファイルだけを、diff の見出しから拾う（版番号だけのpbxprojは含めない）。 */
export function changedFilesOf(diffText) {
  const files = [];
  for (const block of diffText.split(/^diff --git /m).slice(1)) {
    const name = block.match(/^a\/(.+?) b\//)?.[1];
    if (name && meaningfulChangeLines(block).length > 0) files.push(name);
  }
  return files;
}

/** 判定する。戻り値: { needed, base, changedFiles } */
export function decide({ cwd, base, head = "HEAD" }) {
  const diff = execFileSync(
    "git",
    ["diff", "-U0", `${base}...${head}`, "--", ...DISTRIBUTED_PATHSPEC],
    { cwd, encoding: "utf8" },
  );
  const changedFiles = changedFilesOf(diff);
  return { needed: changedFiles.length > 0, base, changedFiles };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base") out.base = argv[++i];
    else if (argv[i] === "--head") out.head = argv[++i];
    else if (argv[i] === "--json") out.json = true;
    else throw new Error(`知らない引数: ${argv[i]}`);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { base, head, json } = parseArgs(process.argv.slice(2));
  if (!base) throw new Error("--base が必要です");
  const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const result = decide({ cwd: root, base, head });
  if (json) {
    console.log(JSON.stringify(result));
  } else {
    console.log(`${result.needed ? "入れ直しが必要" : "入れ直し不要"}`);
    for (const f of result.changedFiles) console.log(`  ${f}`);
  }
}
