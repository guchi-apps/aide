//
//  SessionVault.swift
//  AIDEios
//
//  AIDEのログインCookie（aide_status）をKeychainへ複製し、WebKit側から失われたときの復元元にする。
//  ログアウト・失効でCookieが消えたら、Keychainの控えとWebKitのサイトデータもすべて消す。
//  Cookie値はKeychainへ渡す間だけ扱い、ログ・UserDefaultsには一切出さない。
//

import Foundation
import LocalAuthentication
import WebKit
import WidgetKit
import os

final class SessionVault: NSObject, WKHTTPCookieStoreObserver {
    private static let host = "aide.gucchii.com"
    private static let cookieName = "aide_status"
    private static let account = "aide_status"
    private static let launchedKey = "aide.hasLaunchedBefore"

    private struct StoredSession: Codable {
        let value: String
        let expiresAt: Date?
    }

    private let store = KeychainStore(service: "com.gucchii.AIDEios.session")
    private let logger = Logger(subsystem: "com.gucchii.AIDEios", category: "session")

    private var cookieStore: WKHTTPCookieStore { WKWebsiteDataStore.default().httpCookieStore }
    private var isObserving = false

    /// このプロセス中に有効なセッションCookieを見たか。見た後に消えたらログアウト／失効とみなす。
    /// 現在ログイン中かどうかの判定にも使う（`AppLock.isLoggedIn`）。
    private(set) var hasSeenSession = false
    private var lastSavedValue: String?

    override init() {
        super.init()
        discardStaleItemAfterReinstall()
    }

    /// 本人確認の成功後に呼ぶ。WebKit側にCookieが無ければKeychainから復元し、以後の変化を監視する。
    func sync(context: LAContext) async {
        startObserving()

        let cookies = await cookieStore.allCookies()
        if let current = Self.sessionCookie(in: cookies) {
            record(current)
            return
        }

        let stored: StoredSession
        do {
            guard
                let data = try store.load(account: Self.account, context: context),
                let decoded = try? JSONDecoder().decode(StoredSession.self, from: data)
            else { return }
            stored = decoded
        } catch {
            log("Keychainからの読み出しに失敗", error)
            return
        }

        if let expiresAt = stored.expiresAt, expiresAt <= Date() {
            removeStoredSession()
            return
        }

        guard let cookie = Self.makeCookie(from: stored) else { return }
        await cookieStore.setCookie(cookie)
        hasSeenSession = true
        lastSavedValue = stored.value
    }

    /// ログアウト・失効時の全消去。Keychain・Cookie・localStorage等のサイトデータを残さない。
    func endSession() async {
        removeStoredSession()
        hasSeenSession = false
        lastSavedValue = nil

        // ログアウトした端末へ通知を送り続けない（ショートカット用トークンを使うため、そのトークン自身の失効より先に行う）。
        await PushNotificationManager.shared.revokeStoredToken()

        // ショートカット用トークンもAIDE側で失効させ、この端末からも消す。
        let intentTokenStore = IntentTokenStore()
        if let token = try? intentTokenStore.load() {
            await IntentTokenRevoker().revoke(token: token)
        }
        try? intentTokenStore.delete()

        // ウィジェットに前の室温を残さない。
        RoomSnapshotStore.save(.loggedOut)
        WidgetCenter.shared.reloadTimelines(ofKind: WidgetShared.widgetKind)

        let dataStore = WKWebsiteDataStore.default()
        await dataStore.removeData(
            ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(),
            modifiedSince: .distantPast
        )
    }

    // MARK: - WKHTTPCookieStoreObserver

    func cookiesDidChange(in cookieStore: WKHTTPCookieStore) {
        Task {
            let cookies = await cookieStore.allCookies()
            if let current = Self.sessionCookie(in: cookies) {
                record(current)
            } else if hasSeenSession {
                await endSession()
            }
        }
    }

    // MARK: - 内部処理

    private func startObserving() {
        guard !isObserving else { return }
        isObserving = true
        cookieStore.add(self)
    }

    private func record(_ cookie: HTTPCookie) {
        hasSeenSession = true
        guard cookie.value != lastSavedValue else { return }

        let stored = StoredSession(value: cookie.value, expiresAt: cookie.expiresDate)
        do {
            try store.save(JSONEncoder().encode(stored), account: Self.account)
            lastSavedValue = cookie.value
        } catch {
            log("Keychainへの保存に失敗", error)
        }
    }

    private func removeStoredSession() {
        do {
            try store.delete(account: Self.account)
        } catch {
            log("Keychainからの削除に失敗", error)
        }
    }

    /// iOSのKeychainはアプリを削除しても残る。再インストール直後に前のログイン・ショートカット用トークンを
    /// 復元しないよう、初回起動（UserDefaultsは削除で消える）ではKeychainの控えを捨てる。フラグに秘密は含まない。
    private func discardStaleItemAfterReinstall() {
        let defaults = UserDefaults.standard
        guard !defaults.bool(forKey: Self.launchedKey) else { return }
        removeStoredSession()
        try? IntentTokenStore().delete()
        defaults.set(true, forKey: Self.launchedKey)
    }

    private static func sessionCookie(in cookies: [HTTPCookie]) -> HTTPCookie? {
        cookies.first {
            $0.name == cookieName
                && !$0.value.isEmpty
                && ($0.domain == host || $0.domain == ".\(host)")
        }
    }

    private static func makeCookie(from stored: StoredSession) -> HTTPCookie? {
        var properties: [HTTPCookiePropertyKey: Any] = [
            .name: cookieName,
            .value: stored.value,
            .domain: host,
            .path: "/",
            .secure: "TRUE",
            .sameSitePolicy: HTTPCookieStringPolicy.sameSiteLax.rawValue,
            HTTPCookiePropertyKey("HttpOnly"): "TRUE",
        ]
        if let expiresAt = stored.expiresAt {
            properties[.expires] = expiresAt
        }
        return HTTPCookie(properties: properties)
    }

    /// エラーの種別（OSStatus等）だけを出す。値・Cookie・クエリは出さない。
    private func log(_ message: String, _ error: Error) {
        if case KeychainError.unexpectedStatus(let status) = error {
            logger.error("\(message, privacy: .public) (OSStatus: \(status, privacy: .public))")
        } else {
            logger.error("\(message, privacy: .public)")
        }
    }
}
