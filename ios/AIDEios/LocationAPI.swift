//
//  LocationAPI.swift
//  AIDEios
//
//  位置共有のHTTPS呼び出し（#715の契約。`src/api/location.ts`）と、位置専用トークンの保存。
//  送信本文は latitude / longitude / horizontalAccuracyM（メートル）/ measuredAt（タイムゾーン付きISO 8601）の4項目だけ。
//    POST /api/location/enable   ログインCookieで認証。位置送信専用の端末トークンを1回だけ返す
//    POST /api/location          端末トークン（Bearer）で認証。座標・水平精度・測位時刻を受け取る
//    POST /api/location/disable  端末トークンで認証。トークンの失効と保存済み位置の削除
//  座標・Cookie・トークン・レスポンス本文はログへ出さない（ステータスコードの分類だけを返す）。
//

import Foundation

enum LocationAPIError: Error {
    /// 401/403。トークンが失効している。端末側も共有を止める。
    case unauthorized
    /// 上記以外の4xx（429を除く）。この位置は不正または古いため、再送しても通らない。
    case rejected
    /// 通信失敗・5xx・429。あとで再送する。
    case transient
}

struct LocationAPI {
    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        configuration.waitsForConnectivity = false
        return URLSession(configuration: configuration)
    }()

    private func request(path: String) -> URLRequest {
        var request = URLRequest(url: AIDEConfiguration.baseURL.appending(path: path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return request
    }

    /// ログインCookieから位置送信専用トークンを受け取る。
    func enroll(cookieHeader: String) async throws -> String {
        var request = request(path: "api/location/enable")
        request.setValue(cookieHeader, forHTTPHeaderField: "Cookie")
        request.httpBody = Data("{}".utf8)

        let data = try await perform(request)
        struct Response: Decodable { let token: String }
        guard let token = (try? JSONDecoder().decode(Response.self, from: data))?.token, !token.isEmpty else {
            throw LocationAPIError.rejected
        }
        return token
    }

    func send(_ fix: LocationFix, token: String) async throws {
        var request = request(path: "api/location")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        struct Body: Encodable {
            let latitude: Double
            let longitude: Double
            let horizontalAccuracyM: Double
            let measuredAt: String
        }
        let body = Body(
            latitude: fix.latitude,
            longitude: fix.longitude,
            horizontalAccuracyM: fix.horizontalAccuracy,
            measuredAt: Self.timestamp(fix.measuredAt)
        )
        request.httpBody = try JSONEncoder().encode(body)
        _ = try await perform(request)
    }

    /// 共有の停止／サインアウト。サーバー側のトークン失効と保存位置の削除を依頼する。
    func disable(token: String) async throws {
        var request = request(path: "api/location/disable")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = Data("{}".utf8)
        _ = try await perform(request)
    }

    private func perform(_ request: URLRequest) async throws -> Data {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await Self.session.data(for: request)
        } catch {
            throw LocationAPIError.transient
        }
        guard let http = response as? HTTPURLResponse else { throw LocationAPIError.transient }

        switch http.statusCode {
        case 200..<300: return data
        case 401, 403: throw LocationAPIError.unauthorized
        case 429, 500...: throw LocationAPIError.transient
        default: throw LocationAPIError.rejected
        }
    }

    private static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}

/// 位置送信専用トークンの保存先。セッションCookieとは別のKeychainサービスで、
/// 端末ロック中のバックグラウンド実行でも読める（初回ロック解除後〜）。
struct LocationTokenStore {
    private static let account = "device-token"
    private let store = KeychainStore(service: "com.gucchii.AIDEios.location")

    func load() -> String? {
        guard
            let data = try? store.loadReadableInBackground(account: Self.account),
            let token = String(data: data, encoding: .utf8)
        else { return nil }
        return token
    }

    func save(_ token: String) throws {
        try store.saveReadableInBackground(Data(token.utf8), account: Self.account)
    }

    func delete() {
        try? store.delete(account: Self.account)
    }
}
