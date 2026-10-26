//
//  LocationQueue.swift
//  AIDEios
//
//  位置送信の再送キュー（純粋なロジック。Keychain・CoreLocation・通信に依存しない）。
//  件数と保持期間に上限を持ち、測位時刻の古い位置が新しい位置より後に送られないよう並べる。
//  座標を含むので、ログへ出さない。
//

import Foundation

struct LocationFix: Codable, Equatable {
    let latitude: Double
    let longitude: Double
    /// 水平精度（メートル）。
    let horizontalAccuracy: Double
    /// 端末が測位した時刻。サーバーが受信した時刻とは別物。
    let measuredAt: Date
}

struct LocationQueue: Codable, Equatable {
    static let maxCount = 20
    static let maxAge: TimeInterval = 24 * 60 * 60

    private(set) var fixes: [LocationFix] = []
    /// 送信に成功した（または不正として捨てた）最新の測位時刻。これ以前の位置は送らない。
    private(set) var lastDeliveredAt: Date?

    var isEmpty: Bool { fixes.isEmpty }

    /// 追加して、古いものと上限超過分を捨てる。重複（同じ測位時刻）と配信済み以前の位置は入れない。
    mutating func append(_ fix: LocationFix, now: Date = Date()) {
        if let lastDeliveredAt, fix.measuredAt <= lastDeliveredAt { return }
        if fixes.contains(where: { $0.measuredAt == fix.measuredAt }) { return }
        fixes.append(fix)
        fixes.sort { $0.measuredAt < $1.measuredAt }
        prune(now: now)
    }

    mutating func prune(now: Date = Date()) {
        fixes.removeAll { now.timeIntervalSince($0.measuredAt) > Self.maxAge }
        if fixes.count > Self.maxCount {
            fixes.removeFirst(fixes.count - Self.maxCount)
        }
    }

    /// 次に送る位置。古い順に送り、最後に新しい位置が届くようにする。
    var next: LocationFix? { fixes.first }

    /// `fix`を配信済みとして取り除く（成功、またはサーバーが不正として拒否したとき）。
    mutating func markDelivered(_ fix: LocationFix) {
        fixes.removeAll { $0.measuredAt <= fix.measuredAt }
        if lastDeliveredAt == nil || fix.measuredAt > lastDeliveredAt! {
            lastDeliveredAt = fix.measuredAt
        }
    }

    mutating func removeAll() {
        fixes = []
        lastDeliveredAt = nil
    }
}
