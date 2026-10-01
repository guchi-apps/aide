import assert from "node:assert/strict";
import { test } from "node:test";
import { changedFilesOf, meaningfulChangeLines } from "./ios-changes.mjs";

const swift = `diff --git a/ios/AIDEios/ContentView.swift b/ios/AIDEios/ContentView.swift
--- a/ios/AIDEios/ContentView.swift
+++ b/ios/AIDEios/ContentView.swift
@@ -1 +1 @@
-let a = 1
+let a = 2
`;
const versionOnly = `diff --git a/ios/AIDEios.xcodeproj/project.pbxproj b/ios/AIDEios.xcodeproj/project.pbxproj
--- a/ios/AIDEios.xcodeproj/project.pbxproj
+++ b/ios/AIDEios.xcodeproj/project.pbxproj
@@ -1 +1 @@
-				MARKETING_VERSION = 1.0;
+				MARKETING_VERSION = 2.16.0;
`;

test("Swiftの変更は入れ直し対象", () => {
  assert.deepEqual(changedFilesOf(swift), ["ios/AIDEios/ContentView.swift"]);
});

test("MARKETING_VERSIONの行だけの差分は数えない", () => {
  assert.equal(meaningfulChangeLines(versionOnly).length, 0);
  assert.deepEqual(changedFilesOf(versionOnly), []);
  assert.deepEqual(changedFilesOf(swift + versionOnly), ["ios/AIDEios/ContentView.swift"]);
});
