//
//  AIDERouteTests.swift
//  AIDEiosTests
//
//  `AIDERoute`（DeepLink.swift）は、外部から来るURL（Universal Links・カスタムURLスキーム）を通すか捨てるかを決める唯一の関門。受理・拒否のケースを表形式で確認する。
//  純粋関数なのでKeychain・WebKitは使わない（#68）。
//

import XCTest
@testable import AIDEios

final class AIDERouteTests: XCTestCase {
    private struct AcceptedCase {
        let name: String
        let url: URL
        let expected: String
    }

    private static let acceptedCases: [AcceptedCase] = [
        AcceptedCase(
            name: "通常のパス",
            url: URL(string: "https://aide.gucchii.com/map/room")!,
            expected: "https://aide.gucchii.com/map/room"
        ),
        AcceptedCase(
            name: "クエリ付き",
            url: URL(string: "https://aide.gucchii.com/map?x=1")!,
            expected: "https://aide.gucchii.com/map?x=1"
        ),
        AcceptedCase(
            name: "パス無し（ルート）は/へ正規化される",
            url: URL(string: "https://aide.gucchii.com")!,
            expected: "https://aide.gucchii.com/"
        ),
        AcceptedCase(
            name: "フラグメントは落ちる",
            url: URL(string: "https://aide.gucchii.com/map#frag")!,
            expected: "https://aide.gucchii.com/map"
        ),
        AcceptedCase(
            name: "遮断プレフィックスに前方一致するだけでは遮断されない",
            url: URL(string: "https://aide.gucchii.com/authenticate")!,
            expected: "https://aide.gucchii.com/authenticate"
        ),
        AcceptedCase(
            name: "カスタムスキーム（com.gucchii.aide://open?path=...）",
            url: URL(string: "com.gucchii.aide://open?path=/map/room")!,
            expected: "https://aide.gucchii.com/map/room"
        ),
    ]

    private static let rejectedCases: [(name: String, url: URL)] = [
        ("親ディレクトリ参照（..）", URL(string: "https://aide.gucchii.com/map/../secret")!),
        ("カレントディレクトリ参照（.）", URL(string: "https://aide.gucchii.com/map/./x")!),
        ("エンコード済み..（%2e%2e）", URL(string: "https://aide.gucchii.com/map/%2e%2e/secret")!),
        (
            "エンコード済みスラッシュ（%2F）でauth遮断を回避しようとする",
            URL(string: "https://aide.gucchii.com/status%2Fauth")!
        ),
        ("認証の入口（/status/auth）を遮断", URL(string: "https://aide.gucchii.com/status/auth")!),
        ("認証配下（/status/auth/...）を遮断", URL(string: "https://aide.gucchii.com/status/auth/callback")!),
        ("/authを遮断", URL(string: "https://aide.gucchii.com/auth")!),
        ("ポート指定を拒否", URL(string: "https://aide.gucchii.com:8080/map")!),
        ("ユーザー情報付きを拒否", URL(string: "https://user@aide.gucchii.com/map")!),
        ("httpスキームを拒否", URL(string: "http://aide.gucchii.com/map")!),
        ("別ホストを拒否", URL(string: "https://evil.com/map")!),
        ("バックスラッシュを含むパスを拒否", URL(string: "https://aide.gucchii.com/map%5C..%5Csecret")!),
        (
            "長すぎるURL（2048文字超）を拒否",
            URL(string: "https://aide.gucchii.com/" + String(repeating: "a", count: 2048))!
        ),
        (
            "カスタムスキームでも認証コールバックは対象外（host無し）",
            URL(string: "com.gucchii.aide:///auth/callback?code=abc")!
        ),
        ("カスタムスキームでpathクエリが無い", URL(string: "com.gucchii.aide://open")!),
        (
            "カスタムスキームでpathが//始まり（ホストすり替え）を拒否",
            URL(string: "com.gucchii.aide://open?path=//evil.com/x")!
        ),
        ("カスタムスキームでpathが相対パス（/始まりでない）", URL(string: "com.gucchii.aide://open?path=map/room")!),
    ]

    func testAcceptedURLsProduceExpectedRoute() {
        for testCase in Self.acceptedCases {
            XCTAssertEqual(
                AIDERoute(url: testCase.url)?.url.absoluteString,
                testCase.expected,
                testCase.name
            )
        }
    }

    func testRejectedURLsProduceNilRoute() {
        for testCase in Self.rejectedCases {
            XCTAssertNil(AIDERoute(url: testCase.url), testCase.name)
        }
    }
}
