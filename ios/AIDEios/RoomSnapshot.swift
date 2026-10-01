//
//  RoomSnapshot.swift
//  AIDEios
//
//  ウィジェットに表示する室温のスナップショット。アプリとWidget Extensionの両方のTargetに含める。
//  App Group共有のUserDefaultsに保存する。認証情報（Cookie・トークン）は含めない。
//

import Foundation

enum WidgetShared {
    static let appGroupID = "group.com.gucchii.AIDEios"
    static let widgetKind = "AIDERoomWidget"
    static let roomURL = URL(string: "https://aide.gucchii.com/map")!
}

struct RoomSnapshot: Codable, Equatable {
    var name: String
    var temperature: Double
    var humidity: Double?
    var outdoorDeltaCelsius: Double?
    /// センサーが最後に測定した時刻。
    var measuredAt: Date
    /// アプリがAIDEから取得できた時刻。
    var fetchedAt: Date

    /// 表示中の値が古いとみなす経過時間。
    static let staleInterval: TimeInterval = 10 * 60

    func isStale(at now: Date) -> Bool {
        now.timeIntervalSince(measuredAt) > Self.staleInterval
    }
}

/// ウィジェットが表示する状態。取得結果そのものではなく「見せ方」を表す。
enum RoomWidgetState: Codable, Equatable {
    case ready(RoomSnapshot)
    /// 通信できなかった。直前の値があれば残す。
    case offline(RoomSnapshot?)
    case loggedOut
    /// まだ一度もアプリで取得していない。
    case empty
}

enum RoomSnapshotStore {
    private static let key = "aide.widget.roomState"

    private static var defaults: UserDefaults? { UserDefaults(suiteName: WidgetShared.appGroupID) }

    static func load() -> RoomWidgetState {
        guard
            let data = defaults?.data(forKey: key),
            let state = try? decoder.decode(RoomWidgetState.self, from: data)
        else { return .empty }
        return state
    }

    static func save(_ state: RoomWidgetState) {
        guard let data = try? encoder.encode(state) else { return }
        defaults?.set(data, forKey: key)
    }

    /// ログアウト・失効時に値を残さない。
    static func clear() {
        defaults?.removeObject(forKey: key)
    }

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()

    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
}
