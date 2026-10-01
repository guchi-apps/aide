//
//  PushNotifications.swift
//  AIDEios
//
//  プッシュ通知（APNs）の入口。通知許可の取得・デバイストークンの登録／更新／失効・通知タップの受け取りを担う。
//  通知本文の内容・送信の判断はAIDE側（Web版が正本）で、ここは受け取って対象画面を開くだけ。
//  ロック中に通知をタップしても、開く先は保持しておき、本人確認後に読み込む（ロックを迂回しない）。
//  デバイストークン・通知本文はログへ出さない。
//

import Combine
import Foundation
import OSLog
import UIKit
import UserNotifications

final class PushNotificationManager: NSObject, UNUserNotificationCenterDelegate {
    static let shared = PushNotificationManager()

    private static let deviceTokenKey = "push.deviceToken"
    private static let uploadedKey = "push.uploadedSignature"

    private let logger = Logger(subsystem: "com.gucchii.AIDEios", category: "push")
    private let registrar = PushRegistrar()
    private let defaults = UserDefaults.standard

    private var deviceToken: String? {
        get { defaults.string(forKey: Self.deviceTokenKey) }
        set { defaults.set(newValue, forKey: Self.deviceTokenKey) }
    }

    /// AIDEへ登録済みの「トークン＋環境＋設定」の組。変わったときだけ再登録する。
    private var uploadedSignature: String? {
        get { defaults.string(forKey: Self.uploadedKey) }
        set { defaults.set(newValue, forKey: Self.uploadedKey) }
    }

    func configure() {
        UNUserNotificationCenter.current().delegate = self
    }

    /// 本人確認後に呼ぶ。未決定なら許可を求め、許可済みならAPNsへ登録する（トークンは変わり得るので毎回）。
    /// 拒否されている場合は、登録済みトークンをAIDEから失効させる。
    @MainActor
    func prepare() async {
        let center = UNUserNotificationCenter.current()
        var settings = await center.notificationSettings()

        if settings.authorizationStatus == .notDetermined {
            _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
            settings = await center.notificationSettings()
        }

        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            UIApplication.shared.registerForRemoteNotifications()
            await uploadIfNeeded()
        default:
            await revokeStoredToken()
        }
    }

    func didRegister(deviceToken data: Data) {
        deviceToken = data.map { String(format: "%02x", $0) }.joined()
        Task { await uploadIfNeeded() }
    }

    func didFailToRegister(_ error: Error) {
        // 端末・署名・Capabilityの問題（Push Notifications未追加など）。値は含めない。
        logger.error("APNsへの登録に失敗しました（\((error as NSError).code)）")
    }

    /// ログアウト・失効時。AIDEへの登録を消し、端末側の控えも捨てる。
    func revokeStoredToken() async {
        guard let token = deviceToken else { return }
        do {
            try await registrar.unregister(deviceToken: token)
            deviceToken = nil
            uploadedSignature = nil
        } catch PushRegistrationError.notConfigured {
            // 認証情報が無く失効できない。控えは残し、次に認証できたとき再試行する。
            logger.notice("認証情報が無いため、通知トークンを失効できませんでした")
        } catch {
            logger.notice("通知トークンの失効に失敗しました")
        }
    }

    private func uploadIfNeeded() async {
        guard let token = deviceToken else { return }
        let preferences = NotificationPreferences.load()
        let signature = [token, PushRegistrar.environment, preferences.disabledKinds.sorted().joined(separator: ",")]
            .joined(separator: "|")
        guard signature != uploadedSignature else { return }

        do {
            try await registrar.register(deviceToken: token, preferences: preferences)
            uploadedSignature = signature
        } catch PushRegistrationError.notConfigured {
            // AIDE用トークン未設定。設定後の次回起動・解除時に再試行する。
            logger.notice("認証情報が無いため、通知トークンを登録できませんでした")
        } catch PushRegistrationError.unauthorized {
            logger.notice("通知トークンの登録が認証で拒否されました")
        } catch {
            logger.notice("通知トークンの登録に失敗しました")
        }
    }

    // MARK: - UNUserNotificationCenterDelegate

    /// アプリを開いている間も、バナーと音で見せる。
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        let kind = notification.request.content.userInfo["kind"] as? String ?? NotificationKind.general
        return NotificationPreferences.load().isEnabled(kind) ? [.banner, .list, .sound] : []
    }

    /// 通知タップ。`path`が有効ならその画面へ、無ければ既定の画面のまま開く。
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier else { return }
        let path = response.notification.request.content.userInfo["path"] as? String
        // 検証（AIDE配下のhttpsか・認証パスでないか）は`AIDERoute`が行う。
        await MainActor.run { _ = DeepLinkRouter.shared.handle(path: path) }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // 起動直後（通知タップからのコールド起動を含む）にデリゲートを設定しないとタップを取りこぼす。
        PushNotificationManager.shared.configure()
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        PushNotificationManager.shared.didRegister(deviceToken: deviceToken)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        PushNotificationManager.shared.didFailToRegister(error)
    }
}
