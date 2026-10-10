//
//  AppLock.swift
//  AIDEios
//
//  起動時・バックグラウンド復帰時にFace ID／パスコードで本人確認するまで、AIDEを表示しない。
//

import Combine
import Foundation
import SwiftUI

final class AppLock: ObservableObject {
    enum Reason: Equatable {
        /// 起動直後・復帰直後。自動で本人確認を始める。
        case required
        /// 利用者がキャンセルした。ボタンを押すまで再試行しない（認証画面の繰り返し表示を防ぐ）。
        case cancelled
        case failed
        case passcodeNotSet
        case unavailable
    }

    enum State: Equatable {
        case locked(Reason)
        case unlocked
    }

    /// バックグラウンドにいた時間がこれを超えたら再ロックする。
    private static let gracePeriod: TimeInterval = 60

    @Published private(set) var state: State = .locked(.required)
    @Published private(set) var isAuthenticating = false

    private let gate = BiometricGate()
    private let vault = SessionVault()
    private var backgroundedAt: Date?

    var isUnlocked: Bool { state == .unlocked }

    /// 現在ログイン中か（有効なセッションCookieを見ているか）。
    var isLoggedIn: Bool { vault.hasSeenSession }

    /// 認証画面を出さずに結果が決まる状態（未設定・利用不可）は、設定から戻った時に自動で再判定する。
    /// キャンセル・失敗は自動で再試行しない。
    func authenticateIfRequired() {
        guard case .locked(let reason) = state else { return }
        guard reason == .required || reason == .passcodeNotSet || reason == .unavailable else { return }
        authenticate()
    }

    func authenticate() {
        guard !isAuthenticating, state != .unlocked else { return }
        isAuthenticating = true

        Task {
            let outcome = await gate.authenticate(reason: "AIDEを開くために本人確認します")
            switch outcome {
            case .success(let context):
                // Cookieを復元してからWebViewの読み込みを許可する。
                await vault.sync(context: context)
                state = .unlocked
            case .cancelled:
                state = .locked(.cancelled)
            case .failed:
                state = .locked(.failed)
            case .passcodeNotSet:
                state = .locked(.passcodeNotSet)
            case .unavailable:
                state = .locked(.unavailable)
            }
            isAuthenticating = false
        }
    }

    func scenePhaseChanged(_ phase: ScenePhase) {
        switch phase {
        case .background:
            if backgroundedAt == nil { backgroundedAt = Date() }
        case .active:
            if let backgroundedAt, state == .unlocked,
               Date().timeIntervalSince(backgroundedAt) > Self.gracePeriod {
                state = .locked(.required)
            }
            backgroundedAt = nil
            authenticateIfRequired()
        default:
            break
        }
    }
}
