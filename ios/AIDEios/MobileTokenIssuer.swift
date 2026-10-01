//
//  MobileTokenIssuer.swift
//  AIDEios
//
//  ショートカット／Siri用のトークンを、Googleログイン経由でAIDEから発行してもらう。
//    1. code_verifier を作り、そのS256を code_challenge にする
//    2. ASWebAuthenticationSession で /status/auth/app/start?scope=mobile を開く
//    3. com.gucchii.aide:/auth/callback?code=... で戻る
//    4. POST /api/mobile/token に code と code_verifier を送り、応答の token を受け取る
//  code・verifier・tokenはログにも画面にも出さない。保存は呼び出し側（IntentTokenStore）が行う。
//

import AuthenticationServices
import CryptoKit
import Foundation
import Security
import UIKit

enum MobileTokenIssuerError: Error, Equatable {
    case cancelled
    case couldNotStart
    case loginFailed
    case unreachable
    case invalidResponse
}

@MainActor
final class MobileTokenIssuer: NSObject, ASWebAuthenticationPresentationContextProviding {
    private static let startPath = "status/auth/app/start"
    private static let tokenURL = AIDEConfiguration.baseURL.appending(path: "api/mobile/token")

    private var session: ASWebAuthenticationSession?

    /// ログイン画面を開き、成功したらトークンを返す。
    func issue() async throws -> String {
        let verifier = try Self.makeVerifier()
        let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64URLEncodedString()

        var components = URLComponents(
            url: AIDEConfiguration.baseURL.appending(path: Self.startPath),
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = [
            URLQueryItem(name: "scope", value: "mobile"),
            URLQueryItem(name: "code_challenge", value: challenge),
        ]
        guard let startURL = components.url else { throw MobileTokenIssuerError.couldNotStart }

        let callbackURL = try await authenticate(startURL: startURL)
        let code = try Self.extractCode(from: callbackURL)
        return try await exchange(code: code, verifier: verifier)
    }

    private func authenticate(startURL: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: startURL,
                callbackURLScheme: AIDEConfiguration.callbackScheme
            ) { callbackURL, error in
                if let callbackURL {
                    continuation.resume(returning: callbackURL)
                } else if let error = error as? ASWebAuthenticationSessionError,
                          error.code == .canceledLogin {
                    continuation.resume(throwing: MobileTokenIssuerError.cancelled)
                } else {
                    continuation.resume(throwing: MobileTokenIssuerError.loginFailed)
                }
            }
            session.presentationContextProvider = self
            // SafariのGoogleログイン状態を使い、パスキー／Face IDをシステム認証画面に任せる（WebView側と同じ）。
            session.prefersEphemeralWebBrowserSession = false
            self.session = session
            if !session.start() {
                self.session = nil
                continuation.resume(throwing: MobileTokenIssuerError.couldNotStart)
            }
        }
    }

    private func exchange(code: String, verifier: String) async throws -> String {
        session = nil

        var request = URLRequest(url: Self.tokenURL, timeoutInterval: 15)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        // どちらもbase64url文字列なので、フォーム区切り文字を含まない。
        request.httpBody = Data("code=\(code)&code_verifier=\(verifier)".utf8)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.httpShouldHandleCookies = false

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw MobileTokenIssuerError.unreachable
        }
        guard let http = response as? HTTPURLResponse else {
            throw MobileTokenIssuerError.invalidResponse
        }
        switch http.statusCode {
        case 200:
            break
        case 401, 403:
            throw MobileTokenIssuerError.loginFailed
        default:
            throw MobileTokenIssuerError.invalidResponse
        }

        struct Payload: Decodable { let token: String }
        guard
            let payload = try? JSONDecoder().decode(Payload.self, from: data),
            let token = IntentTokenStore.normalized(payload.token)
        else { throw MobileTokenIssuerError.invalidResponse }
        return token
    }

    private static func extractCode(from callbackURL: URL) throws -> String {
        guard
            callbackURL.scheme == AIDEConfiguration.callbackScheme,
            callbackURL.host == nil,
            callbackURL.path == AIDEConfiguration.callbackPath,
            let items = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false)?.queryItems,
            items.first(where: { $0.name == "error" }) == nil,
            let code = items.first(where: { $0.name == "code" })?.value,
            code.range(of: #"^[A-Za-z0-9_-]{43}$"#, options: .regularExpression) != nil
        else { throw MobileTokenIssuerError.loginFailed }
        return code
    }

    private static func makeVerifier() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        let result = bytes.withUnsafeMutableBytes { buffer in
            SecRandomCopyBytes(kSecRandomDefault, buffer.count, buffer.baseAddress!)
        }
        guard result == errSecSuccess else { throw MobileTokenIssuerError.couldNotStart }
        return Data(bytes).base64URLEncodedString()
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let windows = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
        return windows.first(where: \.isKeyWindow) ?? windows.first ?? ASPresentationAnchor()
    }
}

private extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
