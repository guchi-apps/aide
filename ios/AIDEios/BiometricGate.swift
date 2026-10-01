//
//  BiometricGate.swift
//  AIDEios
//
//  Face ID／Touch ID／端末パスコードによる本人確認。
//  生体認証が使えない（未登録・ロックアウト）場合は端末パスコードへ自動で切り替わる。
//

import Foundation
import LocalAuthentication

enum BiometricOutcome {
    /// 確認済みの`LAContext`。Keychainの読み出しに渡すと認証画面が再表示されない。
    case success(LAContext)
    /// 利用者が閉じた、またはシステムが中断した。自動では再試行しない。
    case cancelled
    /// 認証に失敗した（不一致・ロックアウトなど）。
    case failed
    /// 端末パスコードが未設定で、確認手段が一つも無い。
    case passcodeNotSet
    /// 上記以外の理由で本人確認を開始できない。
    case unavailable
}

struct BiometricGate {
    func authenticate(reason: String) async -> BiometricOutcome {
        let context = LAContext()

        var policyError: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &policyError) else {
            return classifyUnavailable(policyError)
        }

        do {
            let succeeded = try await context.evaluatePolicy(
                .deviceOwnerAuthentication,
                localizedReason: reason
            )
            return succeeded ? .success(context) : .failed
        } catch {
            return classifyFailure(error)
        }
    }

    private func classifyUnavailable(_ error: NSError?) -> BiometricOutcome {
        guard let code = (error as? LAError)?.code else { return .unavailable }
        return code == .passcodeNotSet ? .passcodeNotSet : .unavailable
    }

    private func classifyFailure(_ error: Error) -> BiometricOutcome {
        guard let code = (error as? LAError)?.code else { return .failed }

        switch code {
        case .userCancel, .systemCancel, .appCancel:
            return .cancelled
        case .passcodeNotSet:
            return .passcodeNotSet
        case .biometryNotAvailable, .biometryNotEnrolled:
            return .unavailable
        default:
            return .failed
        }
    }
}
