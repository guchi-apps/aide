#!/usr/bin/env node
// iOSアプリ（ios/）とAIDE本体（src/・package.json）で「揃えておくべき値」を照合する（#525）。
// subpc には Xcode が無くSwiftをビルドできないため、ビルドしなくても確かめられるずれだけを
// 機械的に拾う。Node標準モジュールだけで動き、依存のインストールは要らない
// （ci.yml が npm ci の前に毎回実行する）。
//
//   node ios/scripts/check-consistency.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const IOS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOT = dirname(IOS_DIR);

const read = (...parts) => readFileSync(join(ROOT, ...parts), "utf8");

/** 失敗の一覧。空なら成功 */
export function collectProblems(files) {
  const problems = [];

  // 1. MARKETING_VERSION は package.json の version と一致
  const { version } = JSON.parse(files.packageJson);
  const versions = [...files.pbxproj.matchAll(/MARKETING_VERSION = ([^;]+);/g)].map((m) =>
    m[1].trim(),
  );
  if (versions.length === 0) {
    problems.push("project.pbxproj に MARKETING_VERSION がありません");
  }
  for (const v of new Set(versions)) {
    if (v !== version) {
      problems.push(
        `MARKETING_VERSION (${v}) が package.json の version (${version}) と違います（node ios/scripts/sync-version.mjs で直る）`,
      );
    }
  }

  // 2. ログインの戻り先: AIDE の APP_CALLBACK_URL と Swift の callbackScheme / Info.plist の URL スキーム
  const redirect = files.appAuth.match(/APP_CALLBACK_URL\s*=\s*"([a-z][a-z0-9+.-]*):/i);
  const scheme = files.contentView.match(/callbackScheme\s*=\s*"([^"]+)"/);
  if (!redirect || !scheme) {
    problems.push(
      "APP_CALLBACK_URL または callbackScheme が読み取れません（書き方を変えたならこのスクリプトも直す）",
    );
  } else {
    if (redirect[1] !== scheme[1]) {
      problems.push(
        `ログインの戻り先のスキームが違います: AIDE は "${redirect[1]}"、Swift は "${scheme[1]}"`,
      );
    }
    if (!files.infoPlist.includes(`<string>${scheme[1]}</string>`)) {
      problems.push(`AIDEios-Info.plist の URL スキームに "${scheme[1]}" がありません`);
    }
  }

  // 3. project.pbxproj を手で編集した場合の壊れ方（括弧・ID参照）
  let depth = 0;
  for (const ch of files.pbxproj) {
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (depth < 0) break;
  }
  if (depth !== 0) problems.push("project.pbxproj の {} の対応が取れていません");

  const defined = new Set(
    [...files.pbxproj.matchAll(/^\t\t([0-9A-F]{24})(?: \/\*[^*]*\*\/)? = \{/gm)].map((m) => m[1]),
  );
  const used = new Set(files.pbxproj.match(/\b[0-9A-F]{24}\b/g) ?? []);
  const undefinedIds = [...used].filter((id) => !defined.has(id));
  if (undefinedIds.length > 0) {
    problems.push(`project.pbxproj に定義の無いIDを参照しています: ${undefinedIds.join(", ")}`);
  }

  return problems;
}

function main() {
  const problems = collectProblems({
    packageJson: read("package.json"),
    pbxproj: read("ios", "AIDEios.xcodeproj", "project.pbxproj"),
    appAuth: read("src", "web", "app-auth.ts"),
    contentView: read("ios", "AIDEios", "ContentView.swift"),
    infoPlist: read("ios", "AIDEios-Info.plist"),
  });

  if (problems.length > 0) {
    console.error("iOSの整合チェックに失敗しました:");
    for (const p of problems) console.error(`- ${p}`);
    process.exit(1);
  }
  console.log("iOSの整合チェック: OK");
}

// テストから import されたときは実行しない
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
