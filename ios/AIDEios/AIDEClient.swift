//
//  AIDEClient.swift
//  AIDEios
//
//  AIDEのモバイル向けAPIから現在の室温を取得する薄いクライアント。
//  myroomへは直接接続せず、AIDEを窓口にする。トークンはヘッダーにだけ載せ、ログへ出さない。
//
//  契約（guchi-apps/aide の子Issueで合意する想定）:
//    GET /api/mobile/room-temperature
//    Authorization: Bearer <token>
//    200 {"sensorName": "リビング", "temperature": 24.5, "measuredAt": "<ISO8601>", "stale": false}
//

import Foundation

struct RoomTemperature: Decodable, Equatable {
    let sensorName: String
    /// 摂氏。
    let temperature: Double
    let measuredAt: Date
    /// センサーの最終測定が古く、現在値とは言えない。
    let stale: Bool
}

enum AIDEClientError: Error, Equatable {
    case notConfigured
    case unauthorized
    case unreachable
    case unavailable
    case invalidResponse
}

struct AIDEClient {
    static let endpoint = URL(string: "https://aide.gucchii.com/api/mobile/room-temperature")!

    var session: URLSession = .shared
    var tokenStore = IntentTokenStore()

    func fetchRoomTemperature() async throws -> RoomTemperature {
        let token: String?
        do {
            token = try tokenStore.load()
        } catch {
            throw AIDEClientError.notConfigured
        }
        guard let token else { throw AIDEClientError.notConfigured }

        var request = URLRequest(url: Self.endpoint, timeoutInterval: 10)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        // Bearerだけで認証する。共有Cookieストアのログインcookieを付けない。
        request.httpShouldHandleCookies = false

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw AIDEClientError.unreachable
        }

        guard let http = response as? HTTPURLResponse else {
            throw AIDEClientError.invalidResponse
        }

        switch http.statusCode {
        case 200:
            break
        case 401, 403:
            throw AIDEClientError.unauthorized
        case 500...599:
            throw AIDEClientError.unavailable
        default:
            throw AIDEClientError.invalidResponse
        }

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601withFractionalSeconds
        do {
            return try decoder.decode(RoomTemperature.self, from: data)
        } catch {
            throw AIDEClientError.invalidResponse
        }
    }
}
