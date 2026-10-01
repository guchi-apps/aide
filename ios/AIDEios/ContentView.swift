//
//  ContentView.swift
//  AIDEios
//
//  Created by guchi on 2026/09/22.
//

import AuthenticationServices
import CryptoKit
import Security
import SwiftUI
import WebKit

enum AIDEConfiguration {
    static let baseURL = URL(string: "https://aide.gucchii.com")!
    static let mapURL = baseURL.appending(path: "map")
    static let webLoginPath = "/status/auth/start"
    static let appLoginPath = "/status/auth/app/start"
    static let appConsumePath = "/status/auth/app/consume"
    static let callbackScheme = "com.gucchii.aide"
    static let callbackPath = "/auth/callback"
}

struct ContentView: View {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var lock = AppLock()
    @EnvironmentObject private var router: DeepLinkRouter
    @State private var authenticationError = ""
    @State private var showsAuthenticationError = false
    @State private var showsTokenSettings = false

    var body: some View {
        ZStack {
            WebView(
                url: AIDEConfiguration.mapURL,
                route: router.pendingRoute,
                isActive: lock.isUnlocked,
                onRouteOpened: router.consume
            ) { message in
                authenticationError = message
                showsAuthenticationError = true
            }
            .ignoresSafeArea(edges: .bottom)
            .alert("ログインできませんでした", isPresented: $showsAuthenticationError) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(authenticationError)
            }

            // ロック中と、アプリ切り替え画面に映る間（非アクティブ時）はAIDEの画面を隠す。
            if !lock.isUnlocked || scenePhase != .active {
                LockView(
                    state: lock.state,
                    isAuthenticating: lock.isAuthenticating,
                    onAuthenticate: lock.authenticate
                )
            }
        }
        .overlay(alignment: .topTrailing) {
            if lock.isUnlocked, scenePhase == .active {
                Button {
                    showsTokenSettings = true
                } label: {
                    Image(systemName: "gearshape")
                        .padding(10)
                        .background(.ultraThinMaterial, in: Circle())
                }
                .accessibilityLabel("ショートカット設定")
                .padding(.trailing, 12)
                .padding(.top, 4)
            }
        }
        .onChange(of: lock.isUnlocked) { _, unlocked in
            if !unlocked { showsTokenSettings = false }
        }
        .sheet(isPresented: $showsTokenSettings) {
            IntentTokenSettingsView()
        }
        .task { lock.authenticateIfRequired() }
        // Universal Links・カスタムURLスキーム・ウィジェットのタップはここに届く。
        .onOpenURL { router.handle($0) }
        .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
            if let url = activity.webpageURL { router.handle(url) }
        }
        .onChange(of: scenePhase) { _, phase in
            lock.scenePhaseChanged(phase)
        }
        .onChange(of: lock.isUnlocked) { _, unlocked in
            // 本人確認後に通知許可を求め、デバイストークンをAIDEへ登録する。
            if unlocked {
                Task { await PushNotificationManager.shared.prepare(isLoggedIn: lock.isLoggedIn) }
            }
        }
    }
}

struct WebView: UIViewRepresentable {
    let url: URL
    /// リンクから開くよう指示された画面。ロック解除後に読み込み、読み込んだら`onRouteOpened`で消費する。
    /// 未ログインならAIDEが認証へ誘導し、`next`に元のパスが入るため、認証後に同じ画面へ戻る。
    let route: AIDERoute?
    /// 本人確認とCookie復元が済むまで読み込まない。
    let isActive: Bool
    let onRouteOpened: (AIDERoute) -> Void
    let onAuthenticationError: (String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onAuthenticationError: onAuthenticationError)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()

        // Cookieを保存し、次回以降もログイン状態を維持する
        configuration.websiteDataStore = .default()

        let webView = WKWebView(
            frame: .zero,
            configuration: configuration
        )

        context.coordinator.webView = webView
        webView.navigationDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true

        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard isActive else { return }

        if let route {
            webView.load(URLRequest(url: route.url))
            // 更新中に状態を書き換えないよう、次のランループで消費する。
            DispatchQueue.main.async { onRouteOpened(route) }
        } else if webView.url == nil, !webView.isLoading {
            webView.load(URLRequest(url: url))
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate, ASWebAuthenticationPresentationContextProviding {
        weak var webView: WKWebView?

        private let onAuthenticationError: (String) -> Void
        private var authenticationSession: ASWebAuthenticationSession?
        private var pendingVerifier: String?

        init(onAuthenticationError: @escaping (String) -> Void) {
            self.onAuthenticationError = onAuthenticationError
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard
                let navigationURL = navigationAction.request.url,
                navigationURL.scheme == AIDEConfiguration.baseURL.scheme,
                navigationURL.host == AIDEConfiguration.baseURL.host,
                navigationURL.path == AIDEConfiguration.webLoginPath
            else {
                decisionHandler(.allow)
                return
            }

            decisionHandler(.cancel)
            let next = URLComponents(url: navigationURL, resolvingAgainstBaseURL: false)?
                .queryItems?
                .first(where: { $0.name == "next" })?
                .value ?? "/map"
            startAuthentication(next: next)
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationResponse: WKNavigationResponse,
            decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
        ) {
            guard
                let response = navigationResponse.response as? HTTPURLResponse,
                response.url?.path == AIDEConfiguration.appConsumePath,
                response.statusCode >= 400
            else {
                decisionHandler(.allow)
                return
            }

            decisionHandler(.cancel)
            showAuthenticationError("ログイン情報を引き継げませんでした。もう一度ログインしてください。")
        }

        private func startAuthentication(next: String) {
            guard authenticationSession == nil else { return }

            do {
                let verifier = try makeVerifier()
                let challenge = makeChallenge(for: verifier)

                var components = URLComponents(
                    url: AIDEConfiguration.baseURL.appending(path: "status/auth/app/start"),
                    resolvingAgainstBaseURL: false
                )!
                components.queryItems = [
                    URLQueryItem(name: "next", value: next),
                    URLQueryItem(name: "code_challenge", value: challenge),
                ]
                guard let startURL = components.url else {
                    throw AuthenticationFlowError.invalidURL
                }

                pendingVerifier = verifier
                let session = ASWebAuthenticationSession(
                    url: startURL,
                    callbackURLScheme: AIDEConfiguration.callbackScheme
                ) { [weak self] callbackURL, error in
                    DispatchQueue.main.async {
                        self?.finishAuthentication(callbackURL: callbackURL, error: error)
                    }
                }
                session.presentationContextProvider = self

                // SafariのGoogleログイン状態を利用し、パスキー／Face IDをシステム認証画面に任せる。
                session.prefersEphemeralWebBrowserSession = false
                authenticationSession = session

                if !session.start() {
                    authenticationSession = nil
                    pendingVerifier = nil
                    throw AuthenticationFlowError.couldNotStart
                }
            } catch {
                showAuthenticationError("ログイン画面を開けませんでした。もう一度お試しください。")
            }
        }

        private func finishAuthentication(callbackURL: URL?, error: Error?) {
            let verifier = pendingVerifier
            pendingVerifier = nil
            authenticationSession = nil

            guard error == nil else {
                showAuthenticationError("ログインをキャンセルしたか、認証を完了できませんでした。")
                return
            }

            guard
                let callbackURL,
                let code = AuthCallback.code(
                    from: callbackURL,
                    scheme: AIDEConfiguration.callbackScheme,
                    path: AIDEConfiguration.callbackPath
                ),
                let verifier
            else {
                showAuthenticationError("ログインを完了できませんでした。もう一度お試しください。")
                return
            }

            loadHandoff(code: code, verifier: verifier)
        }

        private func loadHandoff(code: String, verifier: String) {
            guard let webView else {
                showAuthenticationError("画面を更新できませんでした。アプリを開き直してください。")
                return
            }

            var request = URLRequest(
                url: AIDEConfiguration.baseURL.appending(path: "status/auth/app/consume")
            )
            request.httpMethod = "POST"
            request.setValue(
                "application/x-www-form-urlencoded",
                forHTTPHeaderField: "Content-Type"
            )
            // どちらもbase64url文字列なので、フォーム区切り文字を含まない。
            request.httpBody = Data("code=\(code)&code_verifier=\(verifier)".utf8)
            webView.load(request)
        }

        private func makeVerifier() throws -> String {
            var bytes = [UInt8](repeating: 0, count: 32)
            let result = bytes.withUnsafeMutableBytes { buffer in
                SecRandomCopyBytes(kSecRandomDefault, buffer.count, buffer.baseAddress!)
            }
            guard result == errSecSuccess else {
                throw AuthenticationFlowError.randomGenerationFailed
            }
            return Data(bytes).base64URLEncodedString()
        }

        private func makeChallenge(for verifier: String) -> String {
            Data(SHA256.hash(data: Data(verifier.utf8))).base64URLEncodedString()
        }

        private func showAuthenticationError(_ message: String) {
            onAuthenticationError(message)
        }

        func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
            if let window = webView?.window {
                return window
            }

            let windows = UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .flatMap(\.windows)
            return windows.first(where: \.isKeyWindow) ?? windows.first ?? ASPresentationAnchor()
        }
    }
}

private enum AuthenticationFlowError: Error {
    case invalidURL
    case couldNotStart
    case randomGenerationFailed
}

private extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
