import SwiftUI

import HackDesktopModels

struct ProjectDetailView: View {
  @Environment(DashboardModel.self) private var model
  @Environment(\.openURL) private var openURL

  let project: ProjectSummary

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        header
        actions
        Divider()
        details
      }
      .padding(24)
    }
  }

  private var header: some View {
    HStack(alignment: .center, spacing: 12) {
      Text(project.name)
        .font(.title2)
        .bold()
      StatusBadge(status: project.status)
      Spacer()
    }
  }

  private var actions: some View {
    HStack(spacing: 12) {
      Button("Start") {
        Task { await model.startProject(project) }
      }
      .disabled(!canStart)

      Button("Stop") {
        Task { await model.stopProject(project) }
      }
      .disabled(!canStop)

      Button("Open URL") {
        if let url = devUrl { openURL(url) }
      }
      .disabled(devUrl == nil)

      Button("Open Logs") {
        model.showLogs(for: project)
      }
    }
  }

  private var details: some View {
    VStack(alignment: .leading, spacing: 12) {
      if let devHost = project.devHost {
        detailRow(label: "Dev host", value: devHost)
      }
      if let repoRoot = project.repoRoot {
        detailRow(label: "Repo root", value: repoRoot)
      }
      if let projectDir = project.projectDir, projectDir != project.repoRoot {
        detailRow(label: "Project dir", value: projectDir)
      }
      if let services = project.definedServices, !services.isEmpty {
        detailRow(label: "Services", value: services.joined(separator: ", "))
      }
      detailRow(label: "Kind", value: project.kind.rawValue)
      detailRow(label: "Status", value: project.status.rawValue)
    }
    .frame(maxWidth: 720, alignment: .leading)
  }

  private func detailRow(label: String, value: String) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 12) {
      Text(label)
        .font(.caption)
        .foregroundStyle(.secondary)
        .frame(width: 110, alignment: .leading)
      Text(value)
        .font(.body)
    }
  }

  private var devUrl: URL? {
    guard let host = project.devHost, !host.isEmpty else { return nil }
    if host.contains("://") {
      return URL(string: host)
    }
    return URL(string: "https://\(host)")
  }

  private var canStart: Bool {
    project.status == .stopped || project.status == .unknown || project.status == .unregistered
  }

  private var canStop: Bool {
    project.status == .running
  }
}
