//
//  NotificationKind.swift
//  AIDEios
//
//  プッシュ通知の種別と、種別ごとのオン・オフ設定。
//  種別の追加・意味づけはAIDE側が決める。iOS側は`kind`の文字列をそのまま保持するだけで、
//  未知の種別はオンとして扱う（AIDEが先に種別を増やしても受け取れる）。
//  設定UIは未実装。保存先と送信の形だけ先に用意している（値はAIDEへ登録時に送る）。
//

import Foundation

enum NotificationKind {
    /// 通知payloadの`kind`が無いときの種別。
    static let general = "general"
}

struct NotificationPreferences: Equatable {
    private static let defaultsKey = "push.disabledKinds"

    /// オフにした種別。空なら全種別オン。
    var disabledKinds: Set<String>

    func isEnabled(_ kind: String) -> Bool {
        !disabledKinds.contains(kind)
    }

    /// AIDEへ送る形。オフにした種別だけを`false`で明示する（それ以外はAIDE側の既定＝オン）。
    var payload: [String: Bool] {
        Dictionary(uniqueKeysWithValues: disabledKinds.map { ($0, false) })
    }

    static func load(from defaults: UserDefaults = .standard) -> NotificationPreferences {
        let stored = defaults.stringArray(forKey: defaultsKey) ?? []
        return NotificationPreferences(disabledKinds: Set(stored))
    }

    func save(to defaults: UserDefaults = .standard) {
        defaults.set(disabledKinds.sorted(), forKey: Self.defaultsKey)
    }
}
