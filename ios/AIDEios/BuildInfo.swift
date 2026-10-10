//
//  BuildInfo.swift
//  AIDEios
//
//  ロック画面に出すビルド表示。バージョンとビルド番号はアプリ自身のInfo.plist
//  （CFBundleShortVersionString・CFBundleVersion）から読むので、設定なしで必ず出る。
//  gitの短いSHAは、Run Script build phase（scripts/write-git-sha.sh）が
//  ビルド成果物のInfo.plistへ書いたときだけ末尾に足す（未設定のビルドでは出さない）。
//

import Foundation

enum BuildInfo {
    static var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "不明"
    }

    static var buildNumber: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "不明"
    }

    /// Run Script build phase が書いたときだけ値がある。
    static var gitSHA: String? {
        guard let sha = Bundle.main.object(forInfoDictionaryKey: "AIDEGitSHA") as? String, !sha.isEmpty else {
            return nil
        }
        return sha
    }

    /// 例: `v3.0.0 (build 30001)`、SHAがあれば `v3.0.0 (build 30001) · 7baf5ab`
    static var label: String {
        let base = "v\(version) (build \(buildNumber))"
        guard let gitSHA else { return base }
        return "\(base) · \(gitSHA)"
    }
}
