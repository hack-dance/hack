import SwiftUI

import HackDesktopModels

struct ProjectDetailView: View {
  @Environment(DashboardModel.self) private var model
  @Environment(\.openURL) private var openURL
  @Environment(\.colorScheme) private var colorScheme

  let project: ProjectSummary
  @State private var showOverviewSidebar = true
  @State private var selectedService: String? = nil
  @State private var hoveredService: String? = nil
  @State private var isControlBarHovered = false
  @State private var hoveredControl: ProjectTab? = nil
  @State private var isStartHovered = false
  @State private var isStopHovered = false
  @State private var showInfoPanel = false

  var body: some View {
    @Bindable var model = model
    tabContent
      .id(effectiveTab)
      .transition(.opacity.combined(with: .move(edge: .trailing)))
      .animation(.easeInOut(duration: 0.2), value: effectiveTab)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .overlay(alignment: .bottom) {
        bottomControlBar
          .padding(.bottom, 18)
      }
    .onAppear { ensureSelectedTab() }
    .onChange(of: project.id) { _, _ in
      ensureSelectedTab()
    }
    .onChange(of: model.selectedProjectTab) { _, _ in
      ensureSelectedTab()
    }
  }

  @ViewBuilder
  private var tabContent: some View {
    switch effectiveTab {
    case .overview:
      overviewContent
    case .logs:
      terminalMovedCard(kind: .logs)
    case .shell:
      terminalMovedCard(kind: .shell)
    case .tickets:
      TicketsView(project: project)
    }
  }

  private func terminalMovedCard(kind: TerminalDrawerModel.Kind) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      ContentUnavailableView(
        kind == .logs ? "Logs moved to Terminal Drawer" : "Shell moved to Terminal Drawer",
        systemImage: kind == .logs ? "text.alignleft" : "terminal"
      )
      Button(kind == .logs ? "Open Logs" : "Open Shell") {
        openTerminal(kind: kind)
      }
      .adaptiveToolbarButton()
    }
    .padding(24)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }

  private var overviewContent: some View {
    ScrollView {
      HStack(alignment: .top, spacing: 24) {
        VStack(alignment: .leading, spacing: 20) {
          if !project.isRuntimeConfigured {
            runtimeNotConfiguredCard
          }
          servicesSection
          if showInfoPanel {
            infoSection
              .transition(.move(edge: .bottom).combined(with: .opacity))
          }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)

        if showOverviewSidebar, selectedService != nil {
          Divider()
            .opacity(0.2)
            .transition(.opacity)
          serviceDetailPanel
            .frame(minWidth: 260, idealWidth: 300, maxWidth: 360, maxHeight: .infinity, alignment: .topLeading)
            .transition(.move(edge: .trailing).combined(with: .opacity))
        }
      }
      .padding(24)
      .frame(maxWidth: .infinity, alignment: .topLeading)
      .background(
        RoundedRectangle(cornerRadius: 18, style: .continuous)
          .fill(.ultraThinMaterial)
          .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
              .stroke(Color.white.opacity(0.06), lineWidth: 1)
          )
      )
      .padding(.horizontal, 24)
      .padding(.bottom, 32)
    }
  }

  private var runtimeNotConfiguredCard: some View {
    GlassCard {
      VStack(alignment: .leading, spacing: 12) {
        HStack(spacing: 10) {
          Image(systemName: "info.circle.fill")
            .foregroundStyle(.blue)
            .font(.mono(.title3))
          Text("Runtime not configured")
            .font(.mono(.headline))
        }
        Text("This project uses extensions but doesn't have a runtime configuration. Runtime features like start/stop, logs, and shell access require a hack.json or docker-compose setup.")
          .font(.mono(.subheadline))
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
        if let features = project.featureSummary {
          HStack(spacing: 6) {
            Text("Available:")
              .font(.mono(.caption))
              .foregroundStyle(.secondary)
            Text(features)
              .font(.mono(.caption, weight: .medium))
              .foregroundStyle(.primary)
          }
          .padding(.top, 4)
        }
      }
    }
  }

  private var servicesSection: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 10) {
        Image(systemName: "shippingbox")
          .foregroundStyle(.secondary)
        Text("Services")
          .font(.mono(.headline, weight: .semibold))
        Spacer()
      }
      .overlay(alignment: .bottom) {
        Rectangle()
          .fill(Color.white.opacity(0.08))
          .frame(height: 1)
          .offset(y: 8)
      }
      let services = serviceNames
      if !services.isEmpty {
        VStack(alignment: .leading, spacing: 10) {
          ForEach(services, id: \.self) { service in
            let status = serviceStatus(for: service)
            let isHovered = hoveredService == service
            let isSelected = selectedService == service
            VStack(alignment: .leading, spacing: 6) {
              HStack(spacing: 10) {
                Circle()
                  .fill(status.color)
                  .frame(width: 8, height: 8)
                Text(service)
                  .font(.mono(.subheadline, weight: .semibold))
                Spacer()
                if let urlLabel = status.urlLabel {
                  Button {
                    openServiceHost(urlLabel)
                  } label: {
                    Text(urlLabel)
                      .font(.mono(.caption2))
                  }
                  .buttonStyle(.plain)
                  .linkHover()
                }
                Text(status.label)
                  .font(.mono(.caption))
                  .foregroundStyle(.secondary)
              }
              if let detail = status.detail {
                Text(detail)
                  .font(.mono(.caption2))
                  .foregroundStyle(.tertiary)
              }
            }
            .padding(.vertical, 10)
            .padding(.horizontal, 16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
              RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(isSelected ? Color.accentColor.opacity(0.18) : isHovered ? Color.white.opacity(0.06) : .clear)
                .padding(.horizontal, -20)
            }
            .contentShape(Rectangle())
            .onTapGesture {
              withAnimation(.easeInOut(duration: 0.2)) {
                selectedService = service
                showOverviewSidebar = true
              }
            }
            .onHover { hovering in
              hoveredService = hovering ? service : nil
            }
            .animation(.easeInOut(duration: 0.12), value: isHovered)
            Divider()
              .opacity(isSelected || isHovered ? 0.1 : 0.2)
              .padding(.top, -6)
          }
        }
      } else {
        Text("No services registered.")
          .font(.mono(.subheadline))
          .foregroundStyle(.secondary)
      }
    }
  }

  private var featuresList: [String] {
    project.features ?? project.extensionsEnabled ?? []
  }

  private var infoSection: some View {
    VStack(alignment: .leading, spacing: 16) {
      if !overviewRows.isEmpty {
        sectionHeader("Meta")
        DetailRows(rows: overviewRows)
      }
      if !pathRows.isEmpty {
        sectionHeader("Paths")
        DetailRows(rows: pathRows)
      }
      if !featuresList.isEmpty {
        sectionHeader("Features")
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 120), spacing: 8)], alignment: .leading, spacing: 8) {
          ForEach(featuresList, id: \.self) { feature in
            BadgePill(label: feature, tint: .secondary)
          }
        }
      }
    }
  }

  private func sectionHeader(_ title: String) -> some View {
    Text(title)
      .instrumentLabel()
  }

  private var serviceDetailPanel: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Text("Details")
          .font(.mono(.headline, weight: .semibold))
        Spacer()
        Button("All") {
          withAnimation(.easeInOut(duration: 0.2)) {
            self.selectedService = nil
          }
        }
        .font(.mono(.caption))
        .buttonStyle(PressableIconButtonStyle())
      }
      if let selectedService {
        serviceDetailCard(for: selectedService)
      }
    }
    .padding(16)
    .background(
      RoundedRectangle(cornerRadius: 16, style: .continuous)
        .fill(Color.white.opacity(0.04))
        .overlay(
          RoundedRectangle(cornerRadius: 16, style: .continuous)
            .stroke(Color.white.opacity(0.08), lineWidth: 1)
        )
    )
  }

  private var overviewRows: [DetailRowItem] {
    var rows: [DetailRowItem] = []
    if let devHost = project.devHost {
      rows.append(DetailRowItem(label: "Dev host", value: devHost))
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

  private struct ServiceStatus {
    let label: String
    let color: Color
    let detail: String?
    let urlLabel: String?
  }

  private var runtimeServicesByName: [String: RuntimeService] {
    guard let runtime = project.runtime else { return [:] }
    return Dictionary(uniqueKeysWithValues: runtime.services.map { ($0.service, $0) })
  }

  private var serviceHostsByName: [String: [String]] {
    project.serviceHosts ?? [:]
  }

  private var serviceNames: [String] {
    let defined = project.definedServices ?? []
    let runtime = runtimeServicesByName.keys
    let hosts = serviceHostsByName.keys
    return Array(Set(defined).union(runtime).union(hosts)).sorted()
  }

  private func serviceStatus(for service: String) -> ServiceStatus {
    guard let runtime = runtimeServicesByName[service] else {
      return ServiceStatus(label: "Not running", color: .secondary, detail: nil, urlLabel: serviceHostLabel(for: service))
    }
    let total = runtime.containers.count
    let running = runtime.containers.filter { $0.state.lowercased() == "running" }.count
    let ports = runtime.containers.first(where: { !$0.ports.isEmpty })?.ports
    let detail = ports?.isEmpty == false ? ports : nil
    if total == 0 {
      return ServiceStatus(label: "Not running", color: .secondary, detail: detail, urlLabel: serviceHostLabel(for: service))
    }
    if running == total {
      return ServiceStatus(label: "Running", color: .green, detail: detail, urlLabel: serviceHostLabel(for: service))
    }
    if running > 0 {
      return ServiceStatus(label: "\(running)/\(total) running", color: .orange, detail: detail, urlLabel: serviceHostLabel(for: service))
    }
    return ServiceStatus(label: "Stopped", color: .orange, detail: detail, urlLabel: serviceHostLabel(for: service))
  }

  private func serviceHostLabel(for service: String) -> String? {
    if let hosts = serviceHostsByName[service], let first = hosts.first {
      if hosts.count > 1 {
        return "\(first) +\(hosts.count - 1)"
      }
      return first
    }
    guard let host = project.devHost, !host.isEmpty else { return nil }
    return "\(service).\(host)"
  }

  private func serviceDetailCard(for service: String) -> some View {
    let runtime = runtimeServicesByName[service]
    let containers = runtime?.containers ?? []
    return VStack(alignment: .leading, spacing: 10) {
      Text(service)
        .font(.mono(.subheadline, weight: .semibold))
      if let hostLabel = serviceHostLabel(for: service) {
        Button {
          openServiceHost(hostLabel)
        } label: {
          Text(hostLabel)
            .font(.mono(.caption))
        }
        .buttonStyle(.plain)
        .linkHover()
      }
      if let hosts = serviceHostsByName[service], hosts.count > 1 {
        VStack(alignment: .leading, spacing: 4) {
          ForEach(hosts, id: \.self) { host in
            Button {
              openServiceHost(host)
            } label: {
              Text(host)
                .font(.mono(.caption2))
            }
            .buttonStyle(.plain)
            .linkHover()
          }
        }
      }
      if let runtime {
        let runningCount = containers.filter { $0.state.lowercased() == "running" }.count
          DetailRows(rows: [
            DetailRowItem(label: "Containers", value: "\(containers.count)"),
            DetailRowItem(label: "Running", value: "\(runningCount)")
          ])
        ForEach(containers, id: \.id) { container in
          VStack(alignment: .leading, spacing: 6) {
            Text(container.name)
              .font(.mono(.caption, weight: .semibold))
            Text(container.status)
              .font(.mono(.caption2))
              .foregroundStyle(.secondary)
            if !container.ports.isEmpty {
              Text(container.ports)
                .font(.mono(.caption2))
                .foregroundStyle(.tertiary)
            }
          }
          Divider()
            .opacity(0.2)
        }
      } else {
        Text("No running containers.")
          .font(.mono(.caption))
          .foregroundStyle(.secondary)
      }
    }
  }

  private func openServiceHost(_ host: String) {
    let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    let urlString = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
    if let url = URL(string: urlString) {
      openURL(url)
    }
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

  private var availableTabs: [ProjectTab] {
    var tabs: [ProjectTab] = [.overview]
    if project.isRuntimeConfigured {
      tabs.append(contentsOf: [.logs, .shell])
    }
    if project.supportsTickets {
      tabs.append(.tickets)
    }
    return tabs
  }

  private var effectiveTab: ProjectTab {
    if availableTabs.contains(model.selectedProjectTab) {
      return model.selectedProjectTab
    }
    return .overview
  }

  private func ensureSelectedTab() {
    if !availableTabs.contains(model.selectedProjectTab) {
      model.selectedProjectTab = .overview
    }
  }

  private var bottomControlBar: some View {
    HStack(spacing: 12) {
      HStack(spacing: 6) {
        ForEach(availableTabs, id: \.self) { tab in
          Button {
            if tab == .logs {
              openTerminal(kind: .logs)
              return
            }
            if tab == .shell {
              openTerminal(kind: .shell)
              return
            }
            model.selectedProjectTab = tab
          } label: {
            Image(systemName: tabIcon(tab))
              .font(.mono(.caption, weight: .semibold))
              .foregroundStyle(tab == effectiveTab ? Color.white : Color.secondary)
              .padding(8)
              .background(
                Circle()
                  .fill(tab == effectiveTab ? Color.accentColor : hoveredControl == tab ? Color.white.opacity(0.08) : .clear)
              )
              .accessibilityLabel(tab.rawValue)
          }
          .buttonStyle(PressableCircleButtonStyle())
          .onHover { hovering in
            hoveredControl = hovering ? tab : nil
          }
        }
      }

      Divider()
        .frame(height: 18)

      if canStart {
        Button {
          Task { await model.startProject(project) }
        } label: {
          Image(systemName: "play.fill")
            .font(.mono(.caption, weight: .semibold))
            .padding(8)
            .background(
              Circle()
                .fill(isStartHovered ? Color.white.opacity(0.08) : .clear)
            )
        }
        .buttonStyle(PressableCircleButtonStyle())
        .contentShape(Circle())
        .onHover { hovering in
          isStartHovered = hovering
        }
        .accessibilityLabel("Start project")
      }

      if canStop {
        Button {
          Task { await model.stopProject(project) }
        } label: {
          Image(systemName: "stop.fill")
            .font(.mono(.caption, weight: .semibold))
            .padding(8)
            .background(
              Circle()
                .fill(isStopHovered ? Color.white.opacity(0.08) : .clear)
            )
        }
        .buttonStyle(PressableCircleButtonStyle())
        .contentShape(Circle())
        .onHover { hovering in
          isStopHovered = hovering
        }
        .accessibilityLabel("Stop project")
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 8)
    .background(
      controlBarBackground
    )
    .onHover { hovering in
      isControlBarHovered = hovering
    }
    .animation(.easeInOut(duration: 0.12), value: isControlBarHovered)
  }

  @ViewBuilder
  private var controlBarBackground: some View {
    let shape = Capsule(style: .continuous)
    if colorScheme == .dark {
      shape
        .fill(.regularMaterial)
        .overlay(
          shape.stroke(Color.white.opacity(0.10), lineWidth: 1)
        )
        .shadow(color: Color.black.opacity(0.22), radius: 18, x: 0, y: 10)
    } else {
      shape
        .fill(Color.white.opacity(0.78))
        .overlay(
          shape.stroke(Color.black.opacity(0.08), lineWidth: 1)
        )
        .shadow(color: Color.black.opacity(0.10), radius: 18, x: 0, y: 10)
    }
  }

  private func tabIcon(_ tab: ProjectTab) -> String {
    switch tab {
    case .overview:
      return "square.grid.2x2"
    case .logs:
      return "text.alignleft"
    case .shell:
      return "terminal"
    case .tickets:
      return "ticket"
    }
  }

  private func openTerminal(kind: TerminalDrawerModel.Kind) {
    NotificationCenter.default.post(
      name: .hackTerminalOpenRequested,
      object: nil,
      userInfo: [
        TerminalOpenRequest.projectIdKey: project.id,
        TerminalOpenRequest.kindKey: kind.rawValue
      ]
    )
  }

}
