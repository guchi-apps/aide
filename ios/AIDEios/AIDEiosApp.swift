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

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(router)
        }
    }
}
