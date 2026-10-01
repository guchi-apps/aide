//
//  KeychainStore.swift
//  AIDEios
//
//  認証情報をKeychainへ保存する薄いラッパー。
//  値・アカウント名・SecItemのクエリ内容はログへ出さない（OSStatusだけをエラーに載せる）。
//

import Foundation
import LocalAuthentication
import Security

enum KeychainError: Error {
    case accessControlUnavailable
    case invalidData
    case unexpectedStatus(OSStatus)
}

struct KeychainStore {
    let service: String

    /// 端末パスコード未設定の端末では保存できず、バックアップ・他端末への移行にも含まれない。
    /// 読み出しにはFace ID／Touch ID／パスコードのいずれかが必要（`.userPresence`）。
    func save(_ data: Data, account: String) throws {
        guard let access = SecAccessControlCreateWithFlags(
            nil,
            kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
            .userPresence,
            nil
        ) else {
            throw KeychainError.accessControlUnavailable
        }

        try delete(account: account)

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessControl as String: access,
            kSecValueData as String: data,
        ]
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw KeychainError.unexpectedStatus(status)
        }
    }

    /// 本人確認済みの`LAContext`を渡すと、Keychain側の認証画面は再表示されない。
    /// 項目が無いときは`nil`を返す。
    func load(account: String, context: LAContext) throws -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecUseAuthenticationContext as String: context,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        switch status {
        case errSecSuccess:
            guard let data = result as? Data else { throw KeychainError.invalidData }
            return data
        case errSecItemNotFound:
            return nil
        default:
            throw KeychainError.unexpectedStatus(status)
        }
    }

    /// 項目が無くても成功扱い。削除に認証は要らない。
    func delete(account: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.unexpectedStatus(status)
        }
    }
}
