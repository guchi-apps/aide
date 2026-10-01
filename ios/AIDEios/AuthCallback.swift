//
//  AuthCallback.swift
//  AIDEios
//
//  認証コールバックURL（com.gucchii.aide://...）からcodeを取り出す。通常ログイン（ContentView）と
//  ショートカット用トークン発行（MobileTokenIssuer）で同じ検証をしていたため共通化する。
//

import Foundation

enum AuthCallback {
    private static let codePattern = #"^[A-Za-z0-9_-]{43}$"#

    /// スキーム・ホスト（無し）・パスが一致し、`error`クエリが無く、`code`が既定の形式
    /// （43文字のbase64url文字列）のときだけ`code`を返す。それ以外は`nil`。
    static func code(from url: URL, scheme: String, path: String) -> String? {
        guard
            url.scheme == scheme,
            url.host == nil,
            url.path == path,
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
            items.first(where: { $0.name == "error" }) == nil,
            let code = items.first(where: { $0.name == "code" })?.value,
            code.range(of: codePattern, options: .regularExpression) != nil
        else { return nil }
        return code
    }
}
