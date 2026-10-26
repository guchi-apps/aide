//
//  LocationQueueTests.swift
//  AIDEiosTests
//
//  `LocationQueue`（位置送信の再送キュー）の上限・順序・重複・配信済み以前の拒否を確認する（#716）。
//

import XCTest
@testable import AIDEios

final class LocationQueueTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func fix(minutesAgo: Double) -> LocationFix {
        LocationFix(
            latitude: 35,
            longitude: 139,
            horizontalAccuracy: 50,
            measuredAt: now.addingTimeInterval(-minutesAgo * 60)
        )
    }

    func testSortsOldestFirst() {
        var queue = LocationQueue()
        queue.append(fix(minutesAgo: 1), now: now)
        queue.append(fix(minutesAgo: 10), now: now)
        XCTAssertEqual(queue.next, fix(minutesAgo: 10))
    }

    func testIgnoresDuplicateMeasuredAt() {
        var queue = LocationQueue()
        queue.append(fix(minutesAgo: 5), now: now)
        queue.append(fix(minutesAgo: 5), now: now)
        XCTAssertEqual(queue.fixes.count, 1)
    }

    func testDropsFixesOlderThanMaxAge() {
        var queue = LocationQueue()
        queue.append(fix(minutesAgo: 25 * 60), now: now)
        XCTAssertTrue(queue.isEmpty)
    }

    func testKeepsOnlyNewestUpToMaxCount() {
        var queue = LocationQueue()
        for i in 0..<(LocationQueue.maxCount + 5) {
            queue.append(fix(minutesAgo: Double(i)), now: now)
        }
        XCTAssertEqual(queue.fixes.count, LocationQueue.maxCount)
        XCTAssertEqual(queue.fixes.last, fix(minutesAgo: 0))
    }

    func testRejectsFixesNotNewerThanLastDelivered() {
        var queue = LocationQueue()
        queue.append(fix(minutesAgo: 5), now: now)
        queue.markDelivered(fix(minutesAgo: 5))
        queue.append(fix(minutesAgo: 10), now: now)
        queue.append(fix(minutesAgo: 5), now: now)
        XCTAssertTrue(queue.isEmpty)
        queue.append(fix(minutesAgo: 1), now: now)
        XCTAssertEqual(queue.fixes.count, 1)
    }

    func testMarkDeliveredRemovesOlderQueuedFixes() {
        var queue = LocationQueue()
        queue.append(fix(minutesAgo: 10), now: now)
        queue.append(fix(minutesAgo: 5), now: now)
        queue.append(fix(minutesAgo: 1), now: now)
        queue.markDelivered(fix(minutesAgo: 5))
        XCTAssertEqual(queue.fixes, [fix(minutesAgo: 1)])
    }

    func testRemoveAllClearsDeliveredMarker() {
        var queue = LocationQueue()
        queue.markDelivered(fix(minutesAgo: 1))
        queue.removeAll()
        queue.append(fix(minutesAgo: 5), now: now)
        XCTAssertEqual(queue.fixes.count, 1)
    }
}
