//
//  RoomWidget.swift
//  AIDEiosWidget
//
//  室温ウィジェット。ネットワークにもログイン情報にも触れず、アプリが保存した値だけを表示する。
//  RoomSnapshot.swift は Widget Extension のTargetにも含める（Target Membership）。
//

import SwiftUI
import WidgetKit

struct RoomEntry: TimelineEntry {
    let date: Date
    let state: RoomWidgetState
}

struct RoomProvider: TimelineProvider {
    /// アプリが保存した値を読み直す間隔。通信は行わない。
    private static let refreshInterval: TimeInterval = 15 * 60

    func placeholder(in context: Context) -> RoomEntry {
        RoomEntry(date: Date(), state: .ready(Self.sample))
    }

    func getSnapshot(in context: Context, completion: @escaping (RoomEntry) -> Void) {
        let state: RoomWidgetState = context.isPreview ? .ready(Self.sample) : RoomSnapshotStore.load()
        completion(RoomEntry(date: Date(), state: state))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<RoomEntry>) -> Void) {
        let now = Date()
        let entry = RoomEntry(date: now, state: RoomSnapshotStore.load())
        completion(Timeline(entries: [entry], policy: .after(now.addingTimeInterval(Self.refreshInterval))))
    }

    private static let sample = RoomSnapshot(
        name: "リビング",
        temperature: 26.4,
        humidity: 52,
        outdoorDeltaCelsius: 3.1,
        measuredAt: Date(),
        fetchedAt: Date()
    )
}

struct RoomWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: RoomEntry

    var body: some View {
        Group {
            switch entry.state {
            case .ready(let snapshot):
                content(snapshot, offline: false)
            case .offline(let snapshot?):
                content(snapshot, offline: true)
            case .offline(nil):
                message("通信できません", detail: "AIDEを開くと更新します")
            case .loggedOut:
                message("ログインが必要です", detail: "タップしてAIDEを開く")
            case .empty:
                message("AIDEを開いて読み込みます", detail: "室温はアプリを開くと表示されます")
            }
        }
        .widgetURL(WidgetShared.roomURL)
        .containerBackground(.fill.tertiary, for: .widget)
    }

    @ViewBuilder
    private func content(_ snapshot: RoomSnapshot, offline: Bool) -> some View {
        switch family {
        case .accessoryRectangular:
            VStack(alignment: .leading, spacing: 1) {
                Text("室温 \(snapshot.name)").font(.caption2.weight(.bold))
                Text(summaryLine(snapshot)).font(.title3.monospacedDigit())
                Text("\(timeText(snapshot.measuredAt)) 更新").font(.caption2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        case .systemMedium:
            VStack(alignment: .leading, spacing: 6) {
                header(snapshot.name)
                HStack(alignment: .bottom, spacing: 16) {
                    metric(temperatureText(snapshot.temperature), unit: "℃", caption: snapshot.name, large: true, dimmed: offline)
                    if let humidity = snapshot.humidity {
                        metric(String(Int(humidity.rounded())), unit: "%", caption: "湿度", large: false, dimmed: offline)
                    }
                    if let delta = snapshot.outdoorDeltaCelsius {
                        metric(String(format: "%+.1f", delta), unit: "℃", caption: "屋外との差", large: false, dimmed: offline)
                    }
                }
                Spacer(minLength: 0)
                updatedLine(snapshot, offline: offline)
            }
        default:
            VStack(alignment: .leading, spacing: 4) {
                header(snapshot.name)
                Spacer(minLength: 0)
                metric(temperatureText(snapshot.temperature), unit: "℃", caption: nil, large: true, dimmed: offline)
                if let humidity = snapshot.humidity {
                    Text("湿度 \(Int(humidity.rounded()))%")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                updatedLine(snapshot, offline: offline)
            }
        }
    }

    private func header(_ title: String) -> some View {
        Label(title, systemImage: "thermometer.medium")
            .font(.caption.weight(.bold))
            .foregroundStyle(.tint)
    }

    private func metric(_ value: String, unit: String, caption: String?, large: Bool, dimmed: Bool) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 1) {
                Text(value).font(.system(size: large ? 40 : 22, weight: .medium).monospacedDigit())
                Text(unit).font(large ? .title3 : .caption)
            }
            .foregroundStyle(dimmed ? .secondary : .primary)
            if let caption {
                Text(caption).font(.caption2).foregroundStyle(.secondary)
            }
        }
    }

    /// 通信不能、または10分以上更新されていない値は、更新時刻を橙色にして古さを伝える。
    private func updatedLine(_ snapshot: RoomSnapshot, offline: Bool) -> some View {
        let stale = offline || snapshot.isStale(at: entry.date)
        return HStack(spacing: 4) {
            Text("\(timeText(snapshot.measuredAt)) 更新")
            if offline {
                Text("（通信不能）")
            } else if stale {
                Text("（古い）")
            }
        }
        .font(.caption2.monospacedDigit())
        .foregroundStyle(stale ? Color.orange : Color.secondary)
    }

    private func message(_ title: String, detail: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if family != .accessoryRectangular {
                header("AIDE 室温")
            }
            Spacer(minLength: 0)
            Text(title).font(.subheadline.weight(.bold))
            Text(detail).font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func temperatureText(_ value: Double) -> String {
        String(format: "%.1f", value)
    }

    private func summaryLine(_ snapshot: RoomSnapshot) -> String {
        var text = "\(temperatureText(snapshot.temperature))℃"
        if let humidity = snapshot.humidity { text += " \(Int(humidity.rounded()))%" }
        return text
    }

    private func timeText(_ date: Date) -> String {
        date.formatted(.dateTime.hour().minute().locale(Locale(identifier: "ja_JP")))
    }
}

struct RoomWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: WidgetShared.widgetKind, provider: RoomProvider()) { entry in
            RoomWidgetView(entry: entry)
        }
        .configurationDisplayName("AIDE 室温")
        .description("いまの室温と最終更新時刻を表示します。AIDEを開くと更新されます。")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular])
    }
}

@main
struct AIDEiosWidgetBundle: WidgetBundle {
    var body: some Widget {
        RoomWidget()
    }
}
