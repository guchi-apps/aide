//
//  AuthCallbackTests.swift
//  AIDEiosTests
//
//  `AuthCallback.code(from:scheme:path:)`は、通常ログイン（ContentView）が使う、認証コールバックURLの検証。
//  `code`の形式・`error`の有無を含めて受理・拒否のケースを表形式で確認する（#68）。
//

import XCTest
@testable import AIDEios

final class AuthCallbackTests: XCTestCase {
    private static let scheme = "com.gucchii.aide"
    private static let path = "/auth/callback"
    private static let validCode = String(repeating: "a", count: 43)

    private func code(from urlString: String) -> String? {
        AuthCallback.code(from: URL(string: urlString)!, scheme: Self.scheme, path: Self.path)
    }

    func testAcceptsValidCallback() {
        XCTAssertEqual(
            code(from: "com.gucchii.aide:/auth/callback?code=\(Self.validCode)"),
            Self.validCode
        )
    }

    func testAcceptsValidCallbackAlongsideOtherQueryItems() {
        XCTAssertEqual(
            code(from: "com.gucchii.aide:/auth/callback?state=xyz&code=\(Self.validCode)"),
            Self.validCode
        )
    }

    func testRejectsWrongScheme() {
        XCTAssertNil(code(from: "https:/auth/callback?code=\(Self.validCode)"))
    }

    func testRejectsWhenHostIsPresent() {
        // com.gucchii.aide://open/... は DeepLink（AIDERoute）用で、コールバックの形とは別物。
        XCTAssertNil(code(from: "com.gucchii.aide://open/auth/callback?code=\(Self.validCode)"))
    }

    func testRejectsWrongPath() {
        XCTAssertNil(code(from: "com.gucchii.aide:/other?code=\(Self.validCode)"))
    }

    func testRejectsWhenErrorIsPresent() {
        XCTAssertNil(code(from: "com.gucchii.aide:/auth/callback?error=access_denied&code=\(Self.validCode)"))
    }

    func testRejectsMissingCode() {
        XCTAssertNil(code(from: "com.gucchii.aide:/auth/callback"))
    }

    func testRejectsTooShortCode() {
        let tooShort = String(repeating: "a", count: 42)
        XCTAssertNil(code(from: "com.gucchii.aide:/auth/callback?code=\(tooShort)"))
    }

    func testRejectsTooLongCode() {
        let tooLong = String(repeating: "a", count: 44)
        XCTAssertNil(code(from: "com.gucchii.aide:/auth/callback?code=\(tooLong)"))
    }

    func testRejectsCodeWithDisallowedCharacters() {
        let invalid = String(repeating: "a", count: 42) + "+"
        XCTAssertNil(code(from: "com.gucchii.aide:/auth/callback?code=\(invalid)"))
    }
}
