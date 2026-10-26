//
//  LocationSharing.swift
//  AIDEios
//
//  位置のバックグラウンド共有。初期はオフで、利用者が AIDE 内で有効化し、OS の「常に許可」を選んだときだけ動く。
//  移動イベント（significant-change）を使う省電力設計で、一定間隔の測位・送信は約束しない。
//  OS に終了されたアプリは、次の移動イベントで再起動され、`resume()` で監視を張り直す。
//  座標・トークン・Cookie はログへ出さない（Logger には固定文言だけ）。
//

import Combine
import CoreLocation
import Foundation
import Network
import UIKit
import WebKit
import os

@MainActor
final class LocationSharing: NSObject, ObservableObject, CLLocationManagerDelegate {
    static let shared = LocationSharing()

    /// OS の位置権限が共有に足りているか。`sharing` 以外を「共有中」と表示しない。
    enum Status: Equatable {
        case off
        case needsPermission(PermissionIssue)
        case sharing
    }

    enum PermissionIssue: Equatable {
        case notDetermined
        case denied
        case restricted
        /// 「使用中のみ」。バックグラウンドでは測位されない。
        case whenInUseOnly
        /// 「おおよその位置」。精度が粗すぎるので共有しない。
        case approximateOnly
    }

    private static let enabledKey = "aide.location.enabled"
    private static let hasSharedKey = "aide.location.hasShared"
    private static let lastSuccessKey = "aide.location.lastSuccessAt"
    private static let queueFile = "location-queue.json"

    @Published private(set) var status: Status = .off
    @Published private(set) var lastSuccessAt: Date?
    @Published private(set) var message: String?
    @Published private(set) var isWorking = false

    private let manager = CLLocationManager()
    private let api = LocationAPI()
    private let tokens = LocationTokenStore()
    private let logger = Logger(subsystem: "com.gucchii.AIDEios", category: "location")
    private let pathMonitor = NWPathMonitor()

    private var queue = LocationQueue()
    private var isFlushing = false
    private var isMonitoring = false
    private var hasRequestedAlways = false

    private var isEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: Self.enabledKey) }
        set { UserDefaults.standard.set(newValue, forKey: Self.enabledKey) }
    }

    var isOn: Bool { isEnabled }

    private override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        manager.pausesLocationUpdatesAutomatically = true
        lastSuccessAt = UserDefaults.standard.object(forKey: Self.lastSuccessKey) as? Date
    }

    // MARK: - 起動・復帰

    /// アプリ起動時（移動イベントによるバックグラウンド再起動を含む）に呼ぶ。
    func resume() {
        queue = Self.loadQueue()
        refresh()

        pathMonitor.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { return }
            Task { @MainActor in await self?.flushOrRevoke() }
        }
        pathMonitor.start(queue: DispatchQueue(label: "com.gucchii.AIDEios.location.path"))

        Task { await flushOrRevoke() }
    }

    func becameActive() {
        refresh()
        Task { await flushOrRevoke() }
    }

    // MARK: - 利用者の操作

    func enable() async {
        guard !isWorking else { return }
        isWorking = true
        message = nil
        defer { isWorking = false }

        do {
            if tokens.load() == nil {
                guard let cookieHeader = await Self.sessionCookieHeader() else {
                    message = "ログインしていないため、位置共有を有効にできません。"
                    return
                }
                let token = try await api.enroll(cookieHeader: cookieHeader)
                try tokens.save(token)
            }
        } catch {
            message = "位置共有を有効にできませんでした。通信状況を確かめて、もう一度お試しください。"
            return
        }

        isEnabled = true
        hasRequestedAlways = false
        refresh()
        requestPermissionIfNeeded()
    }

    /// 共有オフ。測位を止め、サーバー側のトークン失効と位置削除を依頼する。
    /// 依頼が通らなかったときはトークンを残し、通信が戻り次第あらためて依頼する。
    func disable() async {
        guard !isWorking else { return }
        isWorking = true
        defer { isWorking = false }

        stopLocally()
        await revokeOnServer(keepTokenOnTransientFailure: true)
    }

    /// サインアウト／ログイン失効。Cookie は既に無いので、端末トークンでベストエフォートに失効を依頼し、
    /// 結果によらず端末側のトークンと再送キューを消す。
    func sessionEnded() async {
        stopLocally()
        await revokeOnServer(keepTokenOnTransientFailure: false)
    }

    // MARK: - 権限と測位

    private func refresh() {
        guard isEnabled, tokens.load() != nil else {
            if !isEnabled { stopMonitoring() }
            status = .off
            return
        }

        let issue: PermissionIssue?
        switch manager.authorizationStatus {
        case .notDetermined: issue = .notDetermined
        case .denied: issue = .denied
        case .restricted: issue = .restricted
        case .authorizedWhenInUse: issue = .whenInUseOnly
        case .authorizedAlways:
            issue = manager.accuracyAuthorization == .reducedAccuracy ? .approximateOnly : nil
        @unknown default: issue = .denied
        }

        if let issue {
            // 権限が足りない間は測位も送信も止め、「共有中」と見せない。
            stopMonitoring()
            status = .needsPermission(issue)
            if Self.isRevocation(issue, hadSharing: UserDefaults.standard.bool(forKey: Self.hasSharedKey)) {
                handlePermissionLost()
            }
        } else {
            UserDefaults.standard.set(true, forKey: Self.hasSharedKey)
            startMonitoring()
            status = .sharing
        }
    }

    /// 有効化の途中（未決定・「使用中のみ」から「常に許可」への昇格待ち）は取り消しではない。
    /// 拒否・制限・おおよその位置は常に取り消し、「使用中のみ」は一度でも共有できた後の降格だけを取り消しとみなす。
    private static func isRevocation(_ issue: PermissionIssue, hadSharing: Bool) -> Bool {
        switch issue {
        case .notDetermined: return false
        case .denied, .restricted, .approximateOnly: return true
        case .whenInUseOnly: return hadSharing
        }
    }

    /// OS側で権限が共有要件を満たさなくなった。端末側を止めたうえで、サーバーの保存位置とトークンの失効を依頼する。
    /// 通信できなかったときはトークンを残し、通信が戻り次第あらためて依頼する（`flushOrRevoke`）。
    private func handlePermissionLost() {
        logger.error("位置の権限が共有に足りなくなったため停止しました")
        stopLocally()
        Task { @MainActor in
            await revokeOnServer(keepTokenOnTransientFailure: true)
            if tokens.load() == nil {
                message = "位置情報の権限が取り消されたため、位置共有を停止し、サーバー側の位置を削除しました。"
            }
        }
    }

    private func requestPermissionIfNeeded() {
        switch manager.authorizationStatus {
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse:
            requestAlwaysOnce()
        default:
            break
        }
    }

    private func requestAlwaysOnce() {
        guard !hasRequestedAlways else { return }
        hasRequestedAlways = true
        manager.requestAlwaysAuthorization()
    }

    private func startMonitoring() {
        guard !isMonitoring, CLLocationManager.significantLocationChangeMonitoringAvailable() else { return }
        manager.startMonitoringSignificantLocationChanges()
        isMonitoring = true
    }

    private func stopMonitoring() {
        guard isMonitoring else { return }
        manager.stopMonitoringSignificantLocationChanges()
        isMonitoring = false
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in
            self.refresh()
            if self.isEnabled, manager.authorizationStatus == .authorizedWhenInUse {
                self.requestAlwaysOnce()
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let fixes = locations
            .filter { $0.horizontalAccuracy >= 0 }
            .map {
                LocationFix(
                    latitude: $0.coordinate.latitude,
                    longitude: $0.coordinate.longitude,
                    horizontalAccuracy: $0.horizontalAccuracy,
                    measuredAt: $0.timestamp
                )
            }
        guard !fixes.isEmpty else { return }

        Task { @MainActor in
            guard self.status == .sharing else { return }
            for fix in fixes { self.queue.append(fix) }
            self.saveQueue()
            await self.flush()
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // 権限の拒否は `locationManagerDidChangeAuthorization` で扱う。ここは測位できなかった旨だけ出す。
        let code = (error as? CLError)?.code
        guard code != .denied else { return }
        Task { @MainActor in
            self.message = "現在地を取得できませんでした。電波の届く場所で、しばらくして再度お試しください。"
        }
    }

    // MARK: - 送信

    private func flushOrRevoke() async {
        if isEnabled {
            await flush()
        } else if tokens.load() != nil, !isWorking {
            await revokeOnServer(keepTokenOnTransientFailure: true)
        }
    }

    private func flush() async {
        guard !isFlushing, status == .sharing, let token = tokens.load() else { return }
        isFlushing = true
        // バックグラウンドで起こされた直後でも、送信を終えるまでの短い猶予をOSにもらう。
        var task = UIBackgroundTaskIdentifier.invalid
        task = UIApplication.shared.beginBackgroundTask(withName: "location-upload") {
            UIApplication.shared.endBackgroundTask(task)
            task = .invalid
        }
        defer {
            isFlushing = false
            if task != .invalid { UIApplication.shared.endBackgroundTask(task) }
        }

        queue.prune()
        while let fix = queue.next, status == .sharing {
            do {
                try await api.send(fix, token: token)
                queue.markDelivered(fix)
                saveQueue()
                let now = Date()
                lastSuccessAt = now
                UserDefaults.standard.set(now, forKey: Self.lastSuccessKey)
                message = nil
            } catch LocationAPIError.unauthorized {
                logger.error("位置共有のトークンが失効していたため停止しました")
                stopLocally()
                tokens.delete()
                message = "サーバー側で位置共有が無効になっていたため、停止しました。必要ならもう一度有効にしてください。"
                return
            } catch LocationAPIError.rejected {
                // 不正または古い位置。再送しても通らないので捨てて次へ進む。
                queue.markDelivered(fix)
                saveQueue()
            } catch {
                message = "位置を送信できませんでした。通信が戻り次第、再送します。"
                return
            }
        }
    }

    // MARK: - 停止・失効

    /// 測位・送信を止め、再送キューを消す。トークンはサーバーへの失効依頼のために残す。
    private func stopLocally() {
        isEnabled = false
        UserDefaults.standard.set(false, forKey: Self.hasSharedKey)
        stopMonitoring()
        queue.removeAll()
        Self.deleteQueueFile()
        status = .off
    }

    private func revokeOnServer(keepTokenOnTransientFailure: Bool) async {
        guard let token = tokens.load() else { return }
        do {
            try await api.disable(token: token)
            tokens.delete()
            message = nil
        } catch LocationAPIError.transient where keepTokenOnTransientFailure {
            message = "サーバー側の位置の削除を確認できませんでした。通信が戻り次第、再度依頼します。"
        } catch {
            // 失効済み（401/403）・拒否・サインアウト時は、端末側のトークンを残さない。
            tokens.delete()
        }
    }

    // MARK: - Cookie

    private static func sessionCookieHeader() async -> String? {
        let cookies = await WKWebsiteDataStore.default().httpCookieStore.allCookies()
        guard let cookie = cookies.first(where: {
            $0.name == "aide_status"
                && !$0.value.isEmpty
                && ($0.domain == AIDEConfiguration.baseURL.host || $0.domain == ".\(AIDEConfiguration.baseURL.host ?? "")")
        }) else { return nil }
        return "\(cookie.name)=\(cookie.value)"
    }

    // MARK: - 再送キューの保存

    /// 座標を含むため、端末の初回ロック解除後だけ読めるファイル保護を付け、バックアップから外す。
    private static var queueURL: URL? {
        try? FileManager.default
            .url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appending(path: queueFile)
    }

    private static func loadQueue() -> LocationQueue {
        guard
            let url = queueURL,
            let data = try? Data(contentsOf: url),
            var queue = try? JSONDecoder().decode(LocationQueue.self, from: data)
        else { return LocationQueue() }
        queue.prune()
        return queue
    }

    private func saveQueue() {
        guard var url = Self.queueURL, let data = try? JSONEncoder().encode(queue) else { return }
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
    }

    private static func deleteQueueFile() {
        guard let url = queueURL else { return }
        try? FileManager.default.removeItem(at: url)
    }
}
