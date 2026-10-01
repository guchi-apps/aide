//
//  IntentTokenStore.swift
//  AIDEios
//
//  App Intent（ショートカット／Siri）がAIDEのAPIを呼ぶときのアクセストークンをKeychainへ保存する。
//  Intentはロック中・バックグラウンドでも動くため、`KeychainStore`（`.userPresence`必須）とは別にし、
//  最初のロック解除後は認証UIなしで読める項目にする。端末外へは移らない（バックアップ・他端末対象外）。
//  トークンの値・アカウント名はログへ出さない（OSStatusだけをエラーに載せる）。
//

import Foundation
import Security

struct IntentTokenStore {
    private static let service = "com.gucchii.AIDEios.intent"
    private static let account = "aide_api_token"

    /// 貼り付け入力の前後の空白・改行を除く。空、またはASCIIの表示可能文字以外（途中の空白・制御文字・全角など）を含む場合は`nil`（保存不可）。
    /// `Authorization`ヘッダーへそのまま載せられる文字だけを通す。
    static func normalized(_ input: String) -> String? {
        let token = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard
            !token.isEmpty,
            token.unicodeScalars.allSatisfy({ $0.value >= 0x21 && $0.value <= 0x7E })
        else { return nil }
        return token
    }

    /// 保存済みのトークン。未保存なら`nil`。
    func load() throws -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: Self.account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        switch status {
        case errSecSuccess:
            guard
                let data = result as? Data,
                let token = String(data: data, encoding: .utf8),
                !token.isEmpty
            else { throw KeychainError.invalidData }
            return token
        case errSecItemNotFound:
            return nil
        default:
            throw KeychainError.unexpectedStatus(status)
        }
    }

    func save(_ input: String) throws {
        guard let token = Self.normalized(input) else { throw KeychainError.invalidData }
        try delete()

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: Self.account,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: Data(token.utf8),
        ]
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw KeychainError.unexpectedStatus(status)
        }
    }

    /// 項目が無くても成功扱い。ログアウト・失効時に呼ぶ。
    func delete() throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: Self.account,
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.unexpectedStatus(status)
        }
    }
}
