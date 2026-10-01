//
//  RoomTemperatureIntent.swift
//  AIDEios
//
//  ショートカット／Siriから現在の室温を確認するApp Intent。
//  結果は読み上げ・表示用の文言と、ショートカットで後続に渡せる数値（℃）で返す。
//

import AppIntents
import Foundation

struct RoomTemperatureError: Error, CustomLocalizedStringResourceConvertible {
    let localizedStringResource: LocalizedStringResource

    init(_ error: AIDEClientError) {
        switch error {
        case .notConfigured:
            localizedStringResource = "トークンが未設定です。AIDEアプリ右上の歯車（ショートカット設定）から設定してください。"
        case .unauthorized:
            localizedStringResource = "認証に失敗しました。AIDEアプリ右上の歯車（ショートカット設定）でトークンを設定し直してください。"
        case .unreachable:
            localizedStringResource = "AIDEに接続できませんでした。通信状況を確認してください。"
        case .unavailable:
            localizedStringResource = "AIDEが室温を取得できませんでした。しばらくしてからもう一度お試しください。"
        case .invalidResponse:
            localizedStringResource = "AIDEから想定外の応答が返りました。"
        }
    }
}

struct GetRoomTemperatureIntent: AppIntent {
    static let title: LocalizedStringResource = "室温を確認"
    static let description = IntentDescription("AIDEから現在の部屋の温度を取得します。")

    /// アプリを開かずに結果だけ返す。
    static let openAppWhenRun = false

    func perform() async throws -> some IntentResult & ReturnsValue<Double> & ProvidesDialog {
        let reading: RoomTemperature
        do {
            reading = try await AIDEClient().fetchRoomTemperature()
        } catch let error as AIDEClientError {
            throw RoomTemperatureError(error)
        }

        let value = reading.temperature.formatted(.number.precision(.fractionLength(1)))
        let message = reading.stale
            ? "\(reading.sensorName)の室温は\(value)℃です。ただし、測定が古い可能性があります。"
            : "\(reading.sensorName)の室温は\(value)℃です。"
        return .result(value: reading.temperature, dialog: IntentDialog(stringLiteral: message))
    }
}

struct AIDEShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: GetRoomTemperatureIntent(),
            phrases: [
                "\(.applicationName)で室温を確認",
                "\(.applicationName)で部屋の温度を教えて",
            ],
            shortTitle: "室温を確認",
            systemImageName: "thermometer.medium"
        )
    }
}
