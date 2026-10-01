//
//  IntentTokenRevoker.swift
//  AIDEios
//
//  ショートカット／Siri用のアクセストークンを、AIDE側でも失効させる（自分自身をBearerで失効させる）。
//  失敗しても呼び出し側の処理（Keychainからの削除等）は止めない。トークンの値はログへ出さない。
//
//  契約: DELETE /api/mobile/token, Authorization: Bearer <token>（guchi-apps/aide の handleMobileToken）
//

import Foundation

struct IntentTokenRevoker {
    static let endpoint = URL(string: "https://aide.gucchii.com/api/mobile/token")!

    var session: URLSession = .shared

    /// 指定したトークン自身をAIDE側で失効させる。通信できなくても例外は投げない（呼び出し側任せにしない）。
    func revoke(token: String) async {
        var request = URLRequest(url: Self.endpoint, timeoutInterval: 10)
        request.httpMethod = "DELETE"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.httpShouldHandleCookies = false
        _ = try? await session.data(for: request)
    }
}
