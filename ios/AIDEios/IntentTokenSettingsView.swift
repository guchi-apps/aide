//
//  IntentTokenSettingsView.swift
//  AIDEios
//
//  ショートカット／Siri用のアクセストークンをKeychainへ保存・削除する設定画面。
//  トークンの値は画面に再表示せず、保存済みかどうかだけを示す。値・OSStatusはログにも画面にも出さない。
//

import Combine
import SwiftUI

@MainActor
final class IntentTokenSettingsModel: ObservableObject {
    @Published var input = ""
    @Published private(set) var isSaved = false
    @Published var message: String?
    @Published private(set) var isIssuing = false

    private let store = IntentTokenStore()
    private let issuer = MobileTokenIssuer()
    private let revoker = IntentTokenRevoker()

    var canSave: Bool { IntentTokenStore.normalized(input) != nil }

    func refresh() {
        do {
            isSaved = try store.load() != nil
        } catch {
            isSaved = false
            message = "保存状態を確認できませんでした。"
        }
    }

    func save() {
        guard let token = IntentTokenStore.normalized(input) else {
            message = "トークンが正しくありません。貼り付け直してください。"
            return
        }
        do {
            try store.save(token)
            input = ""
            isSaved = true
            message = "保存しました。"
        } catch {
            message = "保存できませんでした。もう一度お試しください。"
        }
    }

    /// Googleログインでトークンを発行してもらい、そのままKeychainへ保存する。
    func issueByLogin() async {
        guard !isIssuing else { return }
        isIssuing = true
        defer { isIssuing = false }
        do {
            let token = try await issuer.issue()
            // 新しいトークンを確保できてから、古いトークンをAIDE側で失効させる（キャンセル・失敗時に前のトークンを壊さない）。
            if let previous = try? store.load(), previous != token {
                await revoker.revoke(token: previous)
            }
            try store.save(token)
            input = ""
            isSaved = true
            message = "ログインしてトークンを保存しました。"
        } catch let error as MobileTokenIssuerError {
            switch error {
            case .cancelled:
                message = "ログインをキャンセルしました。"
            case .unreachable:
                message = "AIDEへ接続できませんでした。通信状況を確認してください。"
            case .couldNotStart, .loginFailed, .invalidResponse:
                message = "トークンを取得できませんでした。もう一度お試しください。"
            }
        } catch {
            message = "保存できませんでした。もう一度お試しください。"
        }
    }

    func delete() async {
        if let token = try? store.load() {
            await revoker.revoke(token: token)
        }
        do {
            try store.delete()
            isSaved = false
            message = "削除しました。"
        } catch {
            message = "削除できませんでした。もう一度お試しください。"
        }
    }
}

struct IntentTokenSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var model = IntentTokenSettingsModel()
    @State private var confirmsDelete = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("状態", value: model.isSaved ? "保存済み" : "未設定")
                } footer: {
                    Text("ショートカット／Siriでの室温確認と、プッシュ通知の登録に使う、AIDE専用のトークンです。「ログインして取得」で自動的に発行・保存されます。この端末のKeychainにだけ保存され、バックアップや他の端末には移りません。")
                }

                Section {
                    Button {
                        Task { await model.issueByLogin() }
                    } label: {
                        if model.isIssuing {
                            ProgressView()
                        } else {
                            Text(model.isSaved ? "ログインして取得し直す" : "ログインして取得")
                        }
                    }
                    .disabled(model.isIssuing)
                }

                Section("手動で設定（貼り付け）") {
                    SecureField("トークンを貼り付け", text: $model.input)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("保存") { model.save() }
                        .disabled(!model.canSave)
                }

                if model.isSaved {
                    Section {
                        Button("トークンを削除", role: .destructive) { confirmsDelete = true }
                    }
                }

                if let message = model.message {
                    Section { Text(message).font(.footnote) }
                }
            }
            .navigationTitle("ショートカット設定")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("閉じる") { dismiss() }
                }
            }
            .confirmationDialog("保存済みのトークンを削除しますか？", isPresented: $confirmsDelete, titleVisibility: .visible) {
                Button("削除", role: .destructive) { Task { await model.delete() } }
                Button("キャンセル", role: .cancel) {}
            } message: {
                Text("削除するとショートカットから室温を確認できなくなり、プッシュ通知も届かなくなります。")
            }
            .onAppear { model.refresh() }
        }
    }
}
