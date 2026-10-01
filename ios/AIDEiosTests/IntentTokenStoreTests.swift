//
//  IntentTokenStoreTests.swift
//  AIDEiosTests
//
//  `IntentTokenStore.normalized(_:)`は、貼り付け入力を`Authorization`ヘッダーへそのまま
//  載せてよい文字列に絞る唯一の関門。受理・拒否のケースを表形式で確認する（#68）。
//

import XCTest
@testable import AIDEios

final class IntentTokenStoreTests: XCTestCase {
    private static let acceptedCases: [(name: String, input: String, expected: String)] = [
        ("通常のトークン", "abc123XYZ_-", "abc123XYZ_-"),
        ("前後の空白を除去", "  abc123  ", "abc123"),
        ("前後の改行を除去", "\nabc123\n", "abc123"),
        ("印字可能なASCII記号を含む", "a!b#c$d", "a!b#c$d"),
    ]

    private static let rejectedCases: [(name: String, input: String)] = [
        ("空文字", ""),
        ("空白だけ", "   "),
        ("途中に半角スペース", "abc 123"),
        ("途中に改行", "abc\n123"),
        ("途中にタブ", "abc\t123"),
        ("制御文字を含む", "abc\u{0007}123"),
        ("全角文字を含む", "ａｂｃ"),
        ("非ASCII文字を含む", "café"),
    ]

    func testAcceptedInputsAreNormalized() {
        for testCase in Self.acceptedCases {
            XCTAssertEqual(IntentTokenStore.normalized(testCase.input), testCase.expected, testCase.name)
        }
    }

    func testRejectedInputsReturnNil() {
        for testCase in Self.rejectedCases {
            XCTAssertNil(IntentTokenStore.normalized(testCase.input), testCase.name)
        }
    }
}
