import SwiftUI

import HackDesktopModels

struct ProjectDetailView: View {
  @Environment(DashboardModel.self) private var model
  @Environment(\.openURL) private var openURL

  let project: ProjectSummary
  @State private var showInspectorSidebar = true
  @State private var selectedService: String? = nil
  @State private var hoveredService: String? = nil
  @State private var isControlBarHovered = false
  @State private var hoveredControl: ProjectTab? = nil
  @State private var isStartHovered = false
  @State private var isStopHovered = false
  @State private var activeSession: MuxSessionSummary? = nil
  @State private var pendingStopSession: MuxSessionSummary? = nil

  var body: some View {
    @Bindable var model = model
    ZStack(alignment: .top) {
      VStack(alignment: .leading, spacing: 0) {
        tabContent
          .id(effectiveTab)
          .transition(.opacity.combined(with: .move(edge: .trailing)))
          .animation(.easeInOut(duration: 0.2), value: effectiveTab)
          .padding(.top, headerHeight + 8)
          .padding(.bottom, 72)
      }

      header
        .padding(.horizontal, 24)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(topFadeOverlay)
    }
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
    .sheet(item: $activeSession) { session in
      SessionAttachView(project: project, session: session)
    }
    .confirmationDialog(
      "Stop session?",
      isPresented: Binding(
        get: { pendingStopSession != nil },
        set: { value in
          if value == false { pendingStopSession = nil }
        }
      )
    ) {
      Button("Stop", role: .destructive) {
        guard let session = pendingStopSession else { return }
        pendingStopSession = nil
        Task {
          await model.stopSession(sessionName: session.name)
          await model.refresh()
        }
      }
      Button("Cancel", role: .cancel) {
        pendingStopSession = nil
      }
    } message: {
      if let session = pendingStopSession {
        Text("This will kill \(session.name).")
      }
    }
  }

  @ViewBuilder
  private var tabContent: some View {
    switch effectiveTab {
    case .overview:
      projectTabContainer {
        overviewContent
      }
    case .logs:
      projectTabContainer {
        LogsView(project: project, embedded: true)
      }
    case .shell:
      projectTabContainer {
        ShellView(project: project, embedded: true)
      }
    case .tickets:
      projectTabContainer {
        TicketsView(project: project)
      }
    }
  }

  private func projectTabContainer(@ViewBuilder content: () -> some View) -> some View {
    HStack(alignment: .top, spacing: 0) {
      content()
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)

      if showInspectorSidebar {
        Divider()
          .opacity(0.2)
          .transition(.opacity)

        ProjectInspectorColumn(
          project: project,
          meta: projectMeta,
          selectedService: $selectedService,
          onAttachSession: { session in
            activeSession = session
          },
          onStopSession: { session in
            pendingStopSession = session
          },
          onShowLogs: {
            model.showLogs(for: project)
          },
          onShowShell: {
            model.showShell(for: project)
          }
        )
        .frame(
          minWidth: 260,
          idealWidth: 320,
          maxWidth: 380,
          maxHeight: .infinity,
          alignment: .topLeading
        )
        .transition(.move(edge: .trailing).combined(with: .opacity))
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
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
    .animation(.easeInOut(duration: 0.2), value: showInspectorSidebar)
  }

  private var overviewContent: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        if !project.isRuntimeConfigured {
          runtimeNotConfiguredCard
        }
        servicesSection
      }
      .padding(24)
      .frame(maxWidth: .infinity, alignment: .topLeading)
    }
  }

  private var header: some View {
    HStack(alignment: .center, spacing: 12) {
      Image(systemName: project.isRuntimeConfigured ? "cube.transparent.fill" : "puzzlepiece.extension.fill")
        .font(.mono(.title2))
        .foregroundStyle(project.isRuntimeConfigured ? .blue : .purple)
      VStack(alignment: .leading, spacing: 4) {
        HStack(alignment: .center, spacing: 8) {
          Text(project.name)
            .font(.mono(.headline, weight: .semibold))
          headerStatus
        }
        if let headerSubtitle {
          Text(headerSubtitle)
            .font(.mono(.caption2))
            .foregroundStyle(.secondary)
        }
      }
      Spacer()
      primaryActionsBar
      Button {
        withAnimation(.easeInOut(duration: 0.2)) {
          showInspectorSidebar.toggle()
        }
      } label: {
        Image(systemName: "sidebar.trailing")
          .font(.mono(.title3))
      }
      .buttonStyle(PressableCircleButtonStyle())
      .accessibilityLabel(showInspectorSidebar ? "Hide details sidebar" : "Show details sidebar")
    }
  }

  @ViewBuilder
  private var headerStatus: some View {
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

  private var headerSubtitle: String? {
    if let devHost = project.devHost {
      return devHost
    }
    if let featureSummary = project.featureSummary {
      return featureSummary
    }
    return nil
  }

  private var primaryActionsBar: some View {
    Menu {
      Button("Refresh") {
        Task { await model.refresh() }
      }
      if canStart {
        Button("Start") {
          Task { await model.startProject(project) }
        }
      }
      if canStop {
        Button("Stop") {
          Task { await model.stopProject(project) }
        }
      }
      if let url = devUrl {
        Button("Open in Browser") {
          openURL(url)
        }
      }
      Divider()
      Button("View Logs") {
        model.showLogs(for: project)
      }
      Button("Open Shell") {
        model.showShell(for: project)
      }
      if project.supportsTickets {
        Button("Open Tickets") {
          model.showTickets(for: project)
        }
      }
    } label: {
      Image(systemName: "ellipsis.circle")
    }
    .buttonStyle(PressableIconButtonStyle())
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
                showInspectorSidebar = true
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

  private var headerHeight: CGFloat {
    56
  }

  private var topFadeOverlay: some View {
    Rectangle()
      .fill(.ultraThinMaterial)
      .frame(height: headerHeight + 20)
      .mask(
        LinearGradient(
          colors: [Color.white, Color.white.opacity(0)],
          startPoint: .top,
          endPoint: .bottom
        )
      )
      .allowsHitTesting(false)
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

  private var projectMeta: ProjectMeta? {
    project.meta ?? model.projectMetaById[project.id]
  }

  private var runtimeHealthy: Bool? {
    model.runtimeOverallOk
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
      Capsule(style: .continuous)
        .fill(.ultraThinMaterial)
        .overlay(
          Capsule(style: .continuous)
            .fill(isControlBarHovered ? Color.white.opacity(0.06) : .clear)
        )
        .overlay(
          Capsule(style: .continuous)
            .stroke(Color.white.opacity(0.12), lineWidth: 1)
        )
    )
    .onHover { hovering in
      isControlBarHovered = hovering
    }
    .animation(.easeInOut(duration: 0.12), value: isControlBarHovered)
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

}
