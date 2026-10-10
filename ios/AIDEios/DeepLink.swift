//
//  DeepLink.swift
//  AIDEios
//
//  AIDEのリンク（Universal Links・カスタムURLスキーム）から、WKWebViewで開く画面を決める。
//  受け付けるのは https://aide.gucchii.com 配下のパスだけで、それ以外は捨てる。
//  どちらも AIDERoute を作って DeepLinkRouter へ渡す。
//

import Combine
import Foundation

/// アプリ内で開いてよいと確認済みのAIDEの画面。`url`は必ず`AIDEHost.baseURL`配下のhttps URL。
struct AIDERoute: Equatable {
    let url: URL

    /// 認証の入口・コールバックはアプリ自身が扱う。リンクから直接開かせない。
    private static let blockedPathPrefixes = ["/status/auth", "/auth"]
    private static let maxURLLength = 2048

    /// `https://aide.gucchii.com/...` またはカスタムURLスキームのURLから作る。
    /// - カスタムスキームは `com.gucchii.aide://open?path=/map/room` の形だけ受け付ける
    ///   （`com.gucchii.aide:///auth/callback` は認証用のため対象外）。
    init?(url: URL) {
        guard url.absoluteString.count <= Self.maxURLLength else { return nil }

        switch url.scheme?.lowercased() {
        case "https":
            guard let route = Self.validated(url) else { return nil }
            self = route
        case AIDEHost.customScheme:
            guard
                url.host?.lowercased() == "open",
                let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                    .queryItems?.first(where: { $0.name == "path" })?.value,
                path.hasPrefix("/"), !path.hasPrefix("//"),
                let target = URL(string: path, relativeTo: AIDEHost.baseURL)?.absoluteURL,
                let route = Self.validated(target)
            else { return nil }
            self = route
        default:
            return nil
        }
    }

    private init(validatedURL: URL) {
        url = validatedURL
    }

    private static func validated(_ url: URL) -> AIDERoute? {
        guard
            url.scheme?.lowercased() == "https",
            url.host?.lowercased() == AIDEHost.baseURL.host,
            url.port == nil,
            url.user == nil, url.password == nil,
            var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else { return nil }

        let path = components.percentEncodedPath.isEmpty ? "/" : components.percentEncodedPath
        let decoded = path.removingPercentEncoding ?? path
        guard
            !decoded.split(separator: "/").contains(where: { $0 == ".." || $0 == "." }),
            !decoded.contains("\\"),
            !blockedPathPrefixes.contains(where: { decoded == $0 || decoded.hasPrefix($0 + "/") })
        else { return nil }

        // 資格情報やフラグメントは引き継がない。パスとクエリだけを使う。
        components.fragment = nil
        components.percentEncodedPath = path
        guard let normalized = components.url else { return nil }
        return AIDERoute(validatedURL: normalized)
    }
}

enum AIDEHost {
    static let baseURL = URL(string: "https://aide.gucchii.com")!
    static let customScheme = "com.gucchii.aide"
}

/// 開く予定の画面を保持する。ロック中・未ログイン中に届いたリンクも、WebViewが読める状態になるまで持ち続ける。
final class DeepLinkRouter: ObservableObject {
    /// アプリ全体で同じ状態を触るための共有インスタンス。
    static let shared = DeepLinkRouter()

    @Published private(set) var pendingRoute: AIDERoute?

    /// 対応外・不正なURLは何もせず`false`を返す（現在の画面を変えない）。
    @discardableResult
    func handle(_ url: URL) -> Bool {
        guard let route = AIDERoute(url: url) else { return false }
        pendingRoute = route
        return true
    }

    func consume(_ route: AIDERoute) {
        if pendingRoute == route { pendingRoute = nil }
    }
}
