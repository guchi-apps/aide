//
//  AIDEiosApp.swift
//  AIDEios
//
//  Created by guchi on 2026/09/22.
//

import SwiftUI

@main
struct AIDEiosApp: App {
    private let router = DeepLinkRouter.shared

    init() {
        // 移動イベントによるバックグラウンド再起動でも、ここで監視を張り直す。
        LocationSharing.shared.resume()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(router)
        }
    }
}
