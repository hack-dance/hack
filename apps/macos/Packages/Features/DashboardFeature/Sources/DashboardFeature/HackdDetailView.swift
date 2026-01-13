import SwiftUI

struct HackdDetailView: View {
  @Environment(DashboardModel.self) private var model
  @Environment(\.openURL) private var openURL

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        header
        daemonCard
        runtimeCard
      }
      .padding(24)
    }
  }

  private var header: some View {
    HStack(alignment: .center, spacing: 12) {
      Text("Hackd")
        .font(.title2)
        .bold()
      StatusPill(text: daemonStatusText, tone: daemonStatusTone)
      Spacer()
      Button(daemonActionTitle) {
        Task {
          if model.daemonStatus?.running == true {
            await model.stopDaemon()
          } else {
            await model.startDaemon()
          }
        }
      }
      .buttonStyle(.bordered)
    }
  }

  private var daemonCard: some View {
    GroupBox {
      VStack(alignment: .leading, spacing: 12) {
        HStack(spacing: 12) {
          Button("Open Logs") {
            if let logUrl = logUrl {
              openURL(logUrl)
            }
          }
          .disabled(logUrl == nil)
          Button("Refresh Status") {
            Task { await model.refresh() }
          }
        }
        Divider()
        LabeledContent("Status", value: daemonStatusText)
        LabeledContent("PID", value: model.daemonStatus?.pid.map(String.init) ?? "—")
        LabeledContent("Socket", value: model.daemonStatus?.socketPath ?? "—")
        LabeledContent("Socket exists", value: yesNo(model.daemonStatus?.socketExists))
        LabeledContent("Log", value: model.daemonStatus?.logPath ?? "—")
        LabeledContent("Log exists", value: yesNo(model.daemonStatus?.logExists))
        LabeledContent("Last refresh", value: lastUpdatedText)
      }
    } label: {
      Label("Daemon", systemImage: "bolt.horizontal.circle")
    }
  }

  private var runtimeCard: some View {
    GroupBox {
      VStack(alignment: .leading, spacing: 12) {
        HStack {
          StatusPill(text: runtimeStatusText, tone: runtimeStatusTone)
          Spacer()
        }
        if let error = model.runtimeError, !error.isEmpty, model.runtimeOk != true {
          Text(error)
            .font(.caption)
            .foregroundStyle(.red)
        }
        LabeledContent("Checked at", value: model.runtimeCheckedAt ?? "—")
        LabeledContent("Last ok at", value: model.runtimeLastOkAt ?? "—")
        LabeledContent("Reset at", value: model.runtimeResetAt ?? "—")
        LabeledContent("Reset count", value: model.runtimeResetCount.map(String.init) ?? "—")
      }
    } label: {
      Label("Runtime", systemImage: "gauge")
    }
  }

  private var logUrl: URL? {
    guard let logPath = model.daemonStatus?.logPath, !logPath.isEmpty else { return nil }
    return URL(fileURLWithPath: logPath)
  }

  private var daemonActionTitle: String {
    model.daemonStatus?.running == true ? "Stop hackd" : "Start hackd"
  }

  private var daemonStatusText: String {
    if model.daemonStatus?.running == true { return "Running" }
    if model.daemonStatus?.running == false { return "Stopped" }
    return "Unknown"
  }

  private var daemonStatusTone: StatusTone {
    if model.daemonStatus?.running == true { return .good }
    if model.daemonStatus?.running == false { return .warn }
    return .neutral
  }

  private var runtimeStatusText: String {
    if model.runtimeOk == true { return "Healthy" }
    if model.runtimeOk == false { return "Degraded" }
    return "Unknown"
  }

  private var runtimeStatusTone: StatusTone {
    if model.runtimeOk == true { return .good }
    if model.runtimeOk == false { return .warn }
    return .neutral
  }

  private var lastUpdatedText: String {
    guard let date = model.lastUpdated else { return "—" }
    let formatter = RelativeDateTimeFormatter()
    formatter.unitsStyle = .short
    return formatter.localizedString(for: date, relativeTo: Date())
  }

  private func yesNo(_ value: Bool?) -> String {
    guard let value else { return "—" }
    return value ? "Yes" : "No"
  }
}

struct HackdRowView: View {
  let running: Bool?

  var body: some View {
    HStack(spacing: 10) {
      Label("Hackd", systemImage: "bolt.horizontal.circle")
      Spacer()
      StatusPill(text: statusText, tone: statusTone)
    }
  }

  private var statusText: String {
    if running == true { return "Running" }
    if running == false { return "Stopped" }
    return "Unknown"
  }

  private var statusTone: StatusTone {
    if running == true { return .good }
    if running == false { return .warn }
    return .neutral
  }
}

enum StatusTone {
  case good
  case warn
  case neutral
}

struct StatusPill: View {
  let text: String
  let tone: StatusTone

  var body: some View {
    Text(text)
      .font(.caption2.weight(.semibold))
      .padding(.horizontal, 8)
      .padding(.vertical, 3)
      .foregroundStyle(foreground)
      .background(background)
      .clipShape(Capsule())
  }

  private var foreground: Color {
    switch tone {
    case .good:
      return Color.green
    case .warn:
      return Color.orange
    case .neutral:
      return Color.secondary
    }
  }

  private var background: Color {
    switch tone {
    case .good:
      return Color.green.opacity(0.18)
    case .warn:
      return Color.orange.opacity(0.18)
    case .neutral:
      return Color.gray.opacity(0.2)
    }
  }
}
