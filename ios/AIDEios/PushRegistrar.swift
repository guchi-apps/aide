//
//  PushRegistrar.swift
//  AIDEios
//
//  APNsデバイストークンをAIDEへ登録・失効する。認証はApp Intentと同じBearerトークン
//  （`IntentTokenStore`）。トークン・デバイストークンの値はログへ出さない。
//
//  契約（guchi-apps/aide#463で合意する想定）:
//    PUT    /api/mobile/push/devices  {"deviceToken","environment","preferences"} -> 204
//    DELETE /api/mobile/push/devices  {"deviceToken"}                             -> 204
//

import Foundation
import OSLog

enum PushRegistrationError: Error, Equatable {
    case notConfigured
    case unauthorized
    case failed
}

struct PushRegistrar {
    static let endpoint = URL(string: "https://aide.gucchii.com/api/mobile/push/devices")!

    /// Xcodeから実機へ入れたビルドはsandbox、TestFlight・配布ビルドは本番のAPNsを使う。
    static var environment: String {
        #if DEBUG
        "development"
        #else
        "production"
        #endif
    }

    var session: URLSession = .shared
    var tokenStore = IntentTokenStore()

    func register(deviceToken: String, preferences: NotificationPreferences) async throws {
        try await send(
            method: "PUT",
            body: [
                "deviceToken": deviceToken,
                "environment": Self.environment,
                "preferences": preferences.payload,
            ]
        )
    }

    func unregister(deviceToken: String) async throws {
        try await send(method: "DELETE", body: ["deviceToken": deviceToken])
    }

    private func send(method: String, body: [String: Any]) async throws {
        let token: String?
        do {
            token = try tokenStore.load()
        } catch {
            throw PushRegistrationError.notConfigured
        }
        guard let token else { throw PushRegistrationError.notConfigured }

        var request = URLRequest(url: Self.endpoint, timeoutInterval: 10)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.httpShouldHandleCookies = false
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        let response: URLResponse
        do {
            (_, response) = try await session.data(for: request)
        } catch {
            throw PushRegistrationError.failed
        }
        guard let http = response as? HTTPURLResponse else { throw PushRegistrationError.failed }

        switch http.statusCode {
        case 200..<300: return
        case 401, 403: throw PushRegistrationError.unauthorized
        default: throw PushRegistrationError.failed
        }
    }
}
