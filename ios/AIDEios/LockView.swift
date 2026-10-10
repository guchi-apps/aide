//
//  LockView.swift
//  AIDEios
//
//  ロック中・アプリ切り替え時にAIDEの画面を隠す。
//

import SwiftUI
import UIKit

struct LockView: View {
    let state: AppLock.State
    let isAuthenticating: Bool
    let onAuthenticate: () -> Void

    var body: some View {
        ZStack {
            Color(.systemBackground)
                .ignoresSafeArea()

            VStack(spacing: 16) {
                Image(systemName: "lock.fill")
                    .font(.system(size: 44))
                    .foregroundStyle(.secondary)

                Text("AIDE")
                    .font(.title2.bold())

                if let message {
                    Text(message)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }

                if isAuthenticating {
                    ProgressView()
                } else if showsRetryButton {
                    Button("Face IDで開く", action: onAuthenticate)
                        .buttonStyle(.borderedProminent)
                }

                if showsSettingsButton {
                    Button("設定を開く", action: openSettings)
                        .buttonStyle(.bordered)
                }
            }
            .padding(32)

            VStack {
                Spacer()
                Text(BuildInfo.label)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.tertiary)
                    .padding(.bottom, 8)
            }
        }
    }

    private var message: String? {
        guard case .locked(let reason) = state else { return nil }

        switch reason {
        case .required:
            return "Face IDまたは端末のパスコードで本人確認します。"
        case .cancelled:
            return "本人確認がキャンセルされました。もう一度お試しください。"
        case .failed:
            return "本人確認に失敗しました。もう一度お試しください。"
        case .passcodeNotSet:
            return "この端末にパスコードが設定されていないため、AIDEを開けません。設定でパスコードを有効にしてください。"
        case .unavailable:
            return "この端末では本人確認を利用できないため、AIDEを開けません。設定でFace IDまたはパスコードを有効にしてください。"
        }
    }

    private var showsRetryButton: Bool {
        guard case .locked(let reason) = state else { return false }
        return reason != .passcodeNotSet && reason != .unavailable
    }

    private var showsSettingsButton: Bool {
        guard case .locked(let reason) = state else { return false }
        return reason == .passcodeNotSet || reason == .unavailable
    }

    private func openSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }
}
