//
//  RoomFetcher.swift
//  AIDEios
//
//  本人確認後に、AIDEのログインCookieで室温を取得してウィジェット用に保存する。
//  AIDE側のAPI（guchi-apps/aide#455）が前提。Cookie値・応答本文はログへ出さない。
//

import Foundation
import WebKit
import WidgetKit
import os

enum RoomFetcher {
    private static let endpoint = URL(string: "https://aide.gucchii.com/api/room/summary")!
    private static let host = "aide.gucchii.com"
    private static let cookieName = "aide_status"
    private static let logger = Logger(subsystem: "com.gucchii.AIDEios", category: "widget")

    private struct Response: Decodable {
        let name: String?
        let temperature: Double
        let humidity: Double?
        let outdoorDeltaCelsius: Double?
        let measuredAt: Date
    }

    /// 取得して保存し、ウィジェットを再読み込みする。失敗しても呼び出し側には影響させない。
    @MainActor
    static func refresh() async {
        let state = await fetchState()
        RoomSnapshotStore.save(state)
        WidgetCenter.shared.reloadTimelines(ofKind: WidgetShared.widgetKind)
    }

    @MainActor
    private static func fetchState() async -> RoomWidgetState {
        let cookies = await WKWebsiteDataStore.default().httpCookieStore.allCookies()
        guard let cookie = cookies.first(where: {
            $0.name == cookieName && !$0.value.isEmpty && ($0.domain == host || $0.domain == ".\(host)")
        }) else {
            return .loggedOut
        }

        var request = URLRequest(url: endpoint, timeoutInterval: 15)
        request.setValue("\(cookie.name)=\(cookie.value)", forHTTPHeaderField: "Cookie")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        // 自前でCookieヘッダーを付けるため、共有Cookieストアへの自動付与・保存は使わない。
        request.httpShouldHandleCookies = false

        let previous = previousSnapshot()
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { return .offline(previous) }

            switch http.statusCode {
            case 200:
                let decoder = JSONDecoder()
                decoder.dateDecodingStrategy = .iso8601withFractionalSeconds
                let body = try decoder.decode(Response.self, from: data)
                return .ready(RoomSnapshot(
                    name: body.name ?? "室温",
                    temperature: body.temperature,
                    humidity: body.humidity,
                    outdoorDeltaCelsius: body.outdoorDeltaCelsius,
                    measuredAt: body.measuredAt,
                    fetchedAt: Date()
                ))
            case 401, 403:
                return .loggedOut
            default:
                logger.error("室温の取得に失敗 (HTTP \(http.statusCode, privacy: .public))")
                return .offline(previous)
            }
        } catch {
            logger.error("室温の取得に失敗（通信または解析）")
            return .offline(previous)
        }
    }

    private static func previousSnapshot() -> RoomSnapshot? {
        switch RoomSnapshotStore.load() {
        case .ready(let snapshot): snapshot
        case .offline(let snapshot): snapshot
        case .loggedOut, .empty: nil
        }
    }
}

extension JSONDecoder.DateDecodingStrategy {
    /// `2026-09-24T00:38:00.000Z`（小数秒あり）と小数秒なしの両方を受ける。
    static let iso8601withFractionalSeconds = JSONDecoder.DateDecodingStrategy.custom { decoder in
        let text = try decoder.singleValueContainer().decode(String.self)
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: text) { return date }
        if let date = ISO8601DateFormatter().date(from: text) { return date }
        throw DecodingError.dataCorrupted(
            .init(codingPath: decoder.codingPath, debugDescription: "日時の形式が不正です")
        )
    }
}
