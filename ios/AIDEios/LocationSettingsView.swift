//
//  LocationSettingsView.swift
//  AIDEios
//
//  位置共有の設定画面。目的と送信先を示したうえで有効化し、OSの権限状態・最後の送信成功時刻・失敗を表示する。
//  権限が足りない間は「共有中」と表示しない。
//

import SwiftUI

struct LocationSettingsView: View {
    @ObservedObject var sharing: LocationSharing
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle("位置を共有する", isOn: Binding(
                        get: { sharing.isOn },
                        set: { newValue in
                            Task {
                                if newValue {
                                    await sharing.enable()
                                } else {
                                    await sharing.disable()
                                }
                            }
                        }
                    ))
                    .disabled(sharing.isWorking)
                } footer: {
                    Text("オンにすると、このiPhoneの位置をAIDE（aide.gucchii.com）へ自動で送ります。チャットから「最後に測った位置」を確かめるためのもので、AIDEには最新の1件だけを保存します。オフにするとAIDE側の保存位置も削除します。")
                }

                Section("状態") {
                    LabeledContent("共有", value: statusText)
                    LabeledContent("最後に送信できた時刻", value: lastSuccessText)
                    if let message = sharing.message {
                        Text(message).foregroundStyle(.red)
                    }
                    if needsSettings {
                        Button("設定アプリで位置情報を変更") {
                            if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                        }
                    }
                }

                Section {
                    Text("移動を検知したときに送ります。一定の間隔では送られず、静止している間や圏外では更新されません。OSの省電力や、位置サービスの停止でも更新が止まります。")
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
            .navigationTitle("位置共有")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("閉じる") { dismiss() }
                }
            }
        }
    }

    private var needsSettings: Bool {
        guard case .needsPermission(let issue) = sharing.status else { return false }
        return issue != .notDetermined
    }

    private var statusText: String {
        switch sharing.status {
        case .off:
            return "オフ"
        case .sharing:
            return "共有中"
        case .needsPermission(let issue):
            switch issue {
            case .notDetermined: return "位置情報の許可待ち（共有していません）"
            case .denied: return "位置情報が拒否されています（共有していません）"
            case .restricted: return "位置情報が制限されています（共有していません）"
            case .whenInUseOnly: return "「常に許可」が必要です（共有していません）"
            case .approximateOnly: return "「正確な位置情報」をオンにしてください（共有していません）"
            }
        }
    }

    private var lastSuccessText: String {
        guard let date = sharing.lastSuccessAt else { return "まだありません" }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}
