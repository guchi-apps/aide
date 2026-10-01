//
//  BuildInfo.swift
//  AIDEios
//
//  ビルドしたgitの短いSHA。Run Script build phase（scripts/write-git-sha.sh）が
//  ビルド成果物のInfo.plistへ書き込む。未設定のビルドでは「不明」を返す。
//

import Foundation

enum BuildInfo {
    static var gitSHA: String {
        Bundle.main.object(forInfoDictionaryKey: "AIDEGitSHA") as? String ?? "不明"
    }
}
