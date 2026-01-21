import SwiftUI

import HackDesktopModels

struct ProjectDetailView: View {
  @Environment(DashboardModel.self) private var model
  @Environment(\.openURL) private var openURL

  let project: ProjectSummary

  var body: some View {
    @Bindable var model = model
    VStack(alignment: .leading, spacing: 0) {
      headerWithTabs
        .padding(.horizontal, 24)
        .padding(.top, 24)
        .padding(.bottom, 16)

      tabContent
    }
  }

  private var headerWithTabs: some View {
    @Bindable var model = model

    return VStack(alignment: .leading, spacing: 16) {
      header
      if project.isRuntimeConfigured {
        HStack(spacing: 16) {
          Picker("Tab", selection: $model.selectedProjectTab) {
            ForEach(ProjectTab.allCases, id: \.self) { tab in
              Text(tab.rawValue).tag(tab)
            }
          }
          .pickerStyle(.segmented)
          .frame(maxWidth: 280)

          Spacer()

          primaryActionsBar
        }
      } else {
        primaryActionsBar
      }
    }
  }

  @ViewBuilder
  private var tabContent: some View {
    switch model.selectedProjectTab {
    case .overview:
      overviewContent
    case .logs:
      LogsView(project: project, embedded: true)
    case .shell:
      ShellView(project: project, embedded: true)
    }
  }

  private var overviewContent: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        if !project.isRuntimeConfigured {
          runtimeNotConfiguredCard
        }
        overviewCard
        pathsCard
      }
      .padding(.horizontal, 24)
      .padding(.bottom, 24)
    }
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .center, spacing: 12) {
        Image(systemName: project.isRuntimeConfigured ? "cube.transparent.fill" : "puzzlepiece.extension.fill")
          .font(.title)
          .foregroundStyle(project.isRuntimeConfigured ? .blue : .purple)
        VStack(alignment: .leading, spacing: 4) {
          Text(project.name)
            .font(.title2.weight(.semibold))
          if let devHost = project.devHost {
            Text(devHost)
              .font(.subheadline)
              .foregroundStyle(.secondary)
          } else if let featureSummary = project.featureSummary {
            Text(featureSummary)
              .font(.subheadline)
              .foregroundStyle(.secondary)
          }
        }
        Spacer()
        if project.isRuntimeConfigured {
          RuntimeStatusBadge(status: runtimeStatus, runtimeHealthy: runtimeHealthy)
        } else {
          if let label = project.featureLabel {
            LabelBadge(label: label, color: .purple)
          } else {
            LabelBadge(label: "Extensions", color: .purple)
          }
        }
      }
    }
  }

  private var primaryActionsBar: some View {
    HStack(spacing: 12) {
      if canStart {
        Button {
          Task { await model.startProject(project) }
        } label: {
          Label("Start", systemImage: "play.fill")
        }
        .adaptiveToolbarButtonProminent()
      }

      if canStop {
        Button {
          Task { await model.stopProject(project) }
        } label: {
          Label("Stop", systemImage: "stop.fill")
        }
        .buttonStyle(.adaptiveDestructive)
      }

      if devUrl != nil {
        Button {
          if let url = devUrl { openURL(url) }
        } label: {
          Label("Open", systemImage: "arrow.up.right")
        }
        .adaptiveToolbarButton()
      }
    }
  }

  private var runtimeNotConfiguredCard: some View {
    GlassCard {
      VStack(alignment: .leading, spacing: 12) {
        HStack(spacing: 10) {
          Image(systemName: "info.circle.fill")
            .foregroundStyle(.blue)
            .font(.title3)
          Text("Runtime not configured")
            .font(.headline)
        }
        Text("This project uses extensions but doesn't have a runtime configuration. Runtime features like start/stop, logs, and shell access require a hack.json or docker-compose setup.")
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
        if let features = project.featureSummary {
          HStack(spacing: 6) {
            Text("Available:")
              .font(.caption)
              .foregroundStyle(.secondary)
            Text(features)
              .font(.caption.weight(.medium))
              .foregroundStyle(.primary)
          }
          .padding(.top, 4)
        }
      }
    }
  }

  private var overviewCard: some View {
    GlassCard(title: "Overview", systemImage: "rectangle.stack") {
      DetailRows(rows: overviewRows)
    }
  }

  private var pathsCard: some View {
    let rows = pathRows
    return Group {
      if rows.isEmpty {
        EmptyView()
      } else {
        GlassCard(title: "Paths", systemImage: "folder") {
          DetailRows(rows: rows)
        }
      }
    }
  }

  private var overviewRows: [DetailRowItem] {
    var rows: [DetailRowItem] = []
    if let devHost = project.devHost {
      rows.append(DetailRowItem(label: "Dev host", value: devHost))
    }
    if let services = project.definedServices, !services.isEmpty {
      rows.append(DetailRowItem(label: "Services", value: services.joined(separator: ", ")))
    }
    if let featureSummary = project.featureSummary {
      rows.append(DetailRowItem(label: "Features", value: featureSummary))
    }
    if project.isRuntimeConfigured {
      rows.append(DetailRowItem(label: "Runtime", value: runtimeStatusValue))
      rows.append(DetailRowItem(label: "Kind", value: project.kind.rawValue))
      rows.append(DetailRowItem(label: "Status", value: project.status.rawValue))
    } else {
      rows.append(DetailRowItem(label: "Runtime", value: "Not configured"))
      rows.append(DetailRowItem(label: "Kind", value: project.kind.rawValue))
    }
    return rows
  }

  private var pathRows: [DetailRowItem] {
    var rows: [DetailRowItem] = []
    if let repoRoot = project.repoRoot {
      rows.append(DetailRowItem(label: "Repo root", value: repoRoot))
    }
    if let projectDir = project.projectDir, projectDir != project.repoRoot {
      rows.append(DetailRowItem(label: "Project dir", value: projectDir))
    }
    return rows
  }

  private var devUrl: URL? {
    guard let host = project.devHost, !host.isEmpty else { return nil }
    if host.contains("://") {
      return URL(string: host)
    }
    return URL(string: "https://\(host)")
  }

  private var canStart: Bool {
    project.isRuntimeConfigured && (project.status == .stopped || project.status == .unknown || project.status == .unregistered)
  }

  private var canStop: Bool {
    project.isRuntimeConfigured && project.status == .running
  }

  private var runtimeStatus: ProjectRuntimeStatus {
    project.runtimeStatus ?? fallbackRuntimeStatus
  }

  private var runtimeHealthy: Bool? {
    model.runtimeOverallOk
  }

  private var runtimeStatusValue: String {
    let base = project.runtimeStatusLabel
    if runtimeHealthy == false, runtimeStatus == .running {
      return "\(base) (degraded)"
    }
    return base
  }

  private var fallbackRuntimeStatus: ProjectRuntimeStatus {
    switch project.status {
    case .running:
      return .running
    case .stopped:
      return .stopped
    case .missing:
      return .missing
    case .unknown:
      return .unknown
    case .unregistered:
      return .unknown
    }
  }
}
