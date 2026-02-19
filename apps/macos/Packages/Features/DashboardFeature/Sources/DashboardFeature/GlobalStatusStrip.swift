import AppKit
import SwiftUI

import HackDesktopModels

enum GlobalStatusPlacement {
  case content
  case titlebar
}

struct GlobalStatusStrip: View {
  @Environment(DashboardModel.self) private var model
  @Environment(\.colorScheme) private var colorScheme
  let placement: GlobalStatusPlacement
  @State private var isSelectorHeaderHovered = false
  @State private var isSelectorPanelHovered = false
  @State private var isSelectorExpanded = false
  @State private var isSelectorListVisible = false
  @State private var selectorUsesExpandedCorners = false
  @State private var hoveredSelectorProjectId: String? = nil
  @State private var selectorExpandTask: Task<Void, Never>? = nil
  @State private var selectorCollapseTask: Task<Void, Never>? = nil
  @State private var selectorListRevealTask: Task<Void, Never>? = nil
  @State private var selectorCornerResetTask: Task<Void, Never>? = nil
  @State private var stripContentWidth: CGFloat = 0

  init(placement: GlobalStatusPlacement = .content) {
    self.placement = placement
  }

  var body: some View {
    HStack(spacing: 10) {
      selectorPill
      if placement != .titlebar {
        Spacer()
      }
      statusCluster
      if let lastUpdatedText, placement == .titlebar {
        Text(lastUpdatedText)
          .font(.mono(.caption2))
          .foregroundStyle(.secondary)
          .lineLimit(1)
          .truncationMode(.tail)
      }
      titlebarProjectActionControl
      if placement == .titlebar {
        Divider()
          .frame(height: 14)
          .opacity(0.25)
      }
      Menu {
        Button("Refresh") {
          Task { await model.refresh() }
        }

        if let project = selectedProject {
          Divider()

          Menu("Project") {
            if canStopProject(project) {
              Button("Stop") {
                Task { await model.stopProject(project) }
              }
            } else if canStartProject(project) {
              Button("Start") {
                Task { await model.startProject(project) }
              }
            }

            if let url = devUrl(for: project) {
              Button("Open in Browser") {
                NSWorkspace.shared.open(url)
              }
            }

            Divider()

            Button("View Logs") {
              openTerminal(project: project, kind: .logs)
            }
            Button("Open Shell") {
              openTerminal(project: project, kind: .shell)
            }

            if project.supportsTickets {
              Divider()
              Button("Open Tickets") {
                model.selectedItem = .project(project.id)
                model.selectedProjectTab = .tickets
              }
            }
          }
        }

        Divider()

        Menu("Daemon") {
          if canStopDaemon {
            Button("Stop hackd") {
              Task { await model.stopDaemon() }
            }
          } else if canStartDaemon {
            Button("Start hackd") {
              Task { await model.startDaemon() }
            }
          }
        }
      } label: {
        Image(systemName: "ellipsis")
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(titlebarIconForeground)
          .frame(width: 22, height: 22)
          .background(
            Circle()
              .strokeBorder(
                titlebarIconStroke,
                lineWidth: 1
              )
              .background(Circle().fill(Color.clear))
          )
          .contentShape(Circle())
      }
      .menuStyle(.borderlessButton)
      .menuIndicator(.hidden)
      .buttonStyle(.plain)
    }
    .frame(
      minHeight: placement == .titlebar ? selectorContainerHeight : 0,
      maxHeight: placement == .titlebar ? selectorContainerHeight : nil,
      alignment: selectorContainerAlignment
    )
    .padding(.horizontal, placement == .titlebar ? 10 : 0)
    .padding(.vertical, placement == .titlebar ? 0 : 6)
    .contentShape(Rectangle())
    .background(alignment: .topLeading) {
      titlebarPillBackground
    }
    .overlay(alignment: .topLeading) {
      if placement == .titlebar, isSelectorExpanded {
        selectorExpandedPanel
          .offset(y: selectorHeaderHeight)
          .transition(
            .asymmetric(
              insertion: .move(edge: .top).combined(with: .opacity),
              removal: .opacity
            )
          )
      }
    }
    .background {
      GeometryReader { proxy in
        Color.clear
          .onAppear {
            updateStripContentWidth(proxy.size.width)
          }
          .onChange(of: proxy.size.width) { _, width in
            updateStripContentWidth(width)
          }
      }
    }
    .fixedSize(horizontal: placement == .titlebar, vertical: false)
    .animation(.easeInOut(duration: 0.18), value: stripLayoutSignature)
    .onHover { hovering in
      guard placement == .titlebar else { return }
      isSelectorHeaderHovered = hovering
      updateSelectorExpansionFromHover()
    }
    .onDisappear {
      selectorExpandTask?.cancel()
      selectorCollapseTask?.cancel()
      selectorListRevealTask?.cancel()
      selectorCornerResetTask?.cancel()
      selectorExpandTask = nil
      selectorCollapseTask = nil
      selectorListRevealTask = nil
      selectorCornerResetTask = nil
    }
  }

  @ViewBuilder
  private var selectorPill: some View {
    if placement == .titlebar {
      titlebarSelectorPill
    } else {
      selectorMenu
    }
  }

  private var selectorMenu: some View {
    Menu {
      Button("Dashboard") {
        model.selectedItem = .home
      }
      Divider()
      Button("Settings: Runtime") {
        NotificationCenter.default.post(
          name: .hackSettingsRequested,
          object: nil,
          userInfo: [SettingsNavigationRequest.paneKey: SettingsSidebarItem.runtime.rawValue]
        )
      }
      Button("Settings: Gateway") {
        NotificationCenter.default.post(
          name: .hackSettingsRequested,
          object: nil,
          userInfo: [SettingsNavigationRequest.paneKey: SettingsSidebarItem.gateway.rawValue]
        )
      }
      Divider()
      ForEach(model.projects) { project in
        Button(project.name) {
          model.selectedItem = .project(project.id)
        }
      }
    } label: {
      HStack(spacing: 8) {
        Image(systemName: selectorIcon)
          .font(.mono(.caption, weight: .semibold))
        Text(selectorLabel)
          .font(.mono(.caption, weight: .semibold))
          .lineLimit(1)
          .truncationMode(.tail)
          .frame(maxWidth: placement == .titlebar ? 220 : .infinity, alignment: .leading)
        Image(systemName: "chevron.down")
          .font(.system(size: 10, weight: .semibold))
          .foregroundStyle(.secondary)
          .offset(y: 0.5)
      }
      .padding(.horizontal, placement == .titlebar ? 4 : 12)
      .padding(.vertical, placement == .titlebar ? 2 : 6)
      .background(selectorPillBackground)
    }
    .menuStyle(.borderlessButton)
    .menuIndicator(.hidden)
  }

  private var titlebarSelectorPill: some View {
    selectorHeader
      .onTapGesture {
        toggleSelectorExpanded()
      }
  }

  private var selectorHeader: some View {
    HStack(spacing: 8) {
      Image(systemName: selectorIcon)
        .font(.mono(.caption, weight: .semibold))
      Text(selectorLabel)
        .font(.mono(.caption, weight: .semibold))
        .lineLimit(1)
        .truncationMode(.tail)
        .frame(maxWidth: placement == .titlebar ? 220 : .infinity, alignment: .leading)
      Image(systemName: "chevron.down")
        .font(.system(size: 10, weight: .semibold))
        .foregroundStyle(.secondary)
        .rotationEffect(.degrees(isSelectorExpanded ? 180 : 0))
        .offset(y: 0.5)
    }
    .padding(.horizontal, placement == .titlebar ? 8 : 12)
    .padding(.vertical, placement == .titlebar ? 4 : 6)
    .background(selectorHeaderBackground)
    .contentShape(RoundedRectangle(cornerRadius: selectorCornerRadius, style: .continuous))
    .animation(.easeInOut(duration: 0.2), value: isSelectorExpanded)
  }

  @ViewBuilder
  private var selectorHeaderBackground: some View {
    if placement == .titlebar {
      Color.clear
    } else {
      selectorPillBackground
    }
  }

  private var selectorExpandedPanel: some View {
    VStack(spacing: 0) {
      Divider()
        .opacity(0.22)
        .padding(.horizontal, 8)

      ScrollView {
        LazyVStack(spacing: 0) {
          ForEach(Array(selectorProjects.enumerated()), id: \.element.id) { index, project in
            titlebarSelectorProjectRow(project: project)
              .opacity(isSelectorListVisible ? 1 : 0)
              .offset(y: isSelectorListVisible ? 0 : 6)
              .animation(
                .spring(response: 0.34, dampingFraction: 0.85)
                  .delay(Double(index) * 0.025),
                value: isSelectorListVisible
              )

            if index != selectorProjects.count - 1 {
              Divider()
                .opacity(0.20)
                .padding(.horizontal, 8)
            }
          }
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 8)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
    .frame(width: selectorExpandedWidth, height: selectorPanelHeight, alignment: .topLeading)
    .onHover { hovering in
      isSelectorPanelHovered = hovering
      updateSelectorExpansionFromHover()
    }
  }

  private func titlebarSelectorProjectRow(project: ProjectSummary) -> some View {
    Button {
      withAnimation(.easeInOut(duration: 0.18)) {
        model.selectedItem = .project(project.id)
        isSelectorExpanded = false
      }
      selectorExpandTask?.cancel()
      selectorExpandTask = nil
    } label: {
      HStack(spacing: 10) {
        Circle()
          .fill(selectorStatusColor(for: project))
          .frame(width: 7, height: 7)

        VStack(alignment: .leading, spacing: 3) {
          Text(project.name)
            .font(.mono(.caption, weight: .semibold))
            .foregroundStyle(.primary)
            .lineLimit(1)
            .truncationMode(.tail)
          if let host = project.devHost, !host.isEmpty {
            Text(host)
              .font(.mono(.caption2))
              .foregroundStyle(.secondary)
              .lineLimit(1)
              .truncationMode(.tail)
          }
        }

        Spacer(minLength: 8)

        Text(selectorStatusLabel(for: project))
          .font(.mono(.caption2))
          .foregroundStyle(.secondary)
      }
      .padding(.horizontal, 8)
      .padding(.vertical, 8)
      .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
      .background(
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .fill(selectorRowBackground(for: project))
      )
    }
    .buttonStyle(.plain)
    .onHover { hovering in
      if hovering {
        hoveredSelectorProjectId = project.id
      } else if hoveredSelectorProjectId == project.id {
        hoveredSelectorProjectId = nil
      }
    }
  }

  @ViewBuilder
  private var titlebarPillBackground: some View {
    if placement == .titlebar {
      RoundedRectangle(cornerRadius: selectorCornerRadius, style: .continuous)
        .fill(.regularMaterial)
        .overlay(
          RoundedRectangle(cornerRadius: selectorCornerRadius, style: .continuous)
            .fill(titlebarPillTint)
        )
        .overlay(
          RoundedRectangle(cornerRadius: selectorCornerRadius, style: .continuous)
            .strokeBorder(
              titlebarPillStroke,
              lineWidth: 1
            )
        )
        .shadow(
          color: titlebarPillShadow.opacity(isSelectorExpanded ? 1 : 0),
          radius: isSelectorExpanded ? 20 : 0,
          x: 0,
          y: isSelectorExpanded ? 12 : 0
        )
        .frame(
          width: isSelectorExpanded ? selectorExpandedWidth : nil,
          height: selectorContainerHeight,
          alignment: .topLeading
        )
    } else {
      EmptyView()
    }
  }

  @ViewBuilder
  private var selectorPillBackground: some View {
    if colorScheme == .dark {
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .fill(.regularMaterial)
        .overlay(
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .strokeBorder(Color.white.opacity(0.10), lineWidth: 1)
        )
    } else if #available(macOS 26, *) {
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .fill(Color.white.opacity(0.90))
        .overlay(
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .strokeBorder(Color.black.opacity(0.10), lineWidth: 1)
        )
    } else {
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .fill(.ultraThinMaterial)
        .overlay(
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .strokeBorder(Color.white.opacity(0.08), lineWidth: 1)
        )
    }
  }

  @ViewBuilder
  private var statusCluster: some View {
    switch model.selectedItem {
    case .home:
      HStack(spacing: 8) {
        StatusPill(text: runtimeLabel, tone: runtimeTone)
        StatusPill(text: gatewayLabel, tone: gatewayTone)
      }
    case .runtime:
      HStack(spacing: 8) {
        StatusPill(text: runtimeLabel, tone: runtimeTone)
        StatusPill(text: daemonLabel, tone: daemonTone)
      }
    case .gateway:
      StatusPill(text: gatewayLabel, tone: gatewayTone)
    case let .project(id):
      if let project = model.projects.first(where: { $0.id == id }) {
        if project.isRuntimeConfigured {
          projectRuntimeCluster(for: project)
        } else if project.status == .missing {
          StatusPill(text: "Project missing", tone: .warn)
        } else if project.isExtensionOnly {
          LabelBadge(label: project.featureLabel ?? "Extensions", color: .purple)
        } else {
          StatusPill(text: "Runtime not configured", tone: .neutral)
        }
      } else {
        StatusPill(text: "Project: unknown", tone: .neutral)
      }
    case .none:
      StatusPill(text: runtimeLabel, tone: runtimeTone)
    }
  }

  private func projectRuntimeCluster(for project: ProjectSummary) -> some View {
    HStack(spacing: 8) {
      Text(project.runtimeStatusLabel)
        .font(.mono(.caption))
        .foregroundStyle(.secondary)
        .lineLimit(1)
        .truncationMode(.tail)
      RuntimeStatusDot(
        status: project.runtimeStatus ?? fallbackRuntimeStatus(for: project),
        runtimeHealthy: model.runtimeOverallOk
      )
    }
  }

  @ViewBuilder
  private var titlebarProjectActionControl: some View {
    if placement == .titlebar,
       let project = selectedProject,
       project.isRuntimeConfigured {
      projectActionControl(for: project)
    }
  }

  @ViewBuilder
  private func projectActionControl(for project: ProjectSummary) -> some View {
    if let action = model.projectLifecycleActions[project.id] {
      HStack(spacing: 4) {
        ProgressView()
          .controlSize(.small)
        Text(action == .starting ? "Starting…" : "Stopping…")
          .font(.mono(.caption2))
          .foregroundStyle(.secondary)
      }
      .padding(.horizontal, 6)
      .padding(.vertical, 3)
      .background(
        Capsule(style: .continuous)
          .fill(titlebarActionChipFill)
      )
    } else if canStopProject(project) {
      Button {
        Task { await model.stopProject(project) }
      } label: {
        Image(systemName: "stop.fill")
          .font(.system(size: 10, weight: .semibold))
          .frame(width: 18, height: 18)
      }
      .buttonStyle(PressableCircleButtonStyle())
      .help("Stop project")
    } else if canStartProject(project) {
      Button {
        Task { await model.startProject(project) }
      } label: {
        Image(systemName: "play.fill")
          .font(.system(size: 10, weight: .semibold))
          .frame(width: 18, height: 18)
      }
      .buttonStyle(PressableCircleButtonStyle())
      .help("Start project")
    }
  }

  private var runtimeLabel: String {
    switch model.runtimeHealthState {
    case .healthy:
      return "Runtime: healthy"
    case .down:
      return "Runtime: down"
    case .degraded:
      return "Runtime: degraded"
    case .unknown:
      return "Runtime: unknown"
    }
  }

  private var runtimeTone: StatusTone {
    switch model.runtimeHealthState {
    case .healthy:
      return .good
    case .down, .degraded:
      return .warn
    case .unknown:
      return .neutral
    }
  }

  private var daemonLabel: String {
    guard let label = model.daemonStatus?.resolvedLabel else { return "Daemon: unknown" }
    return "Daemon: \(label.rawValue)"
  }

  private var daemonTone: StatusTone {
    guard let label = model.daemonStatus?.resolvedLabel else { return .neutral }
    switch label {
    case .running:
      return .good
    case .starting:
      return .warn
    case .stale, .stopped:
      return .warn
    }
  }

  private var gatewayLabel: String {
    if let label = model.gatewaySummaryState?.label, !label.isEmpty {
      return "Gateway: \(label)"
    }
    return "Gateway: unknown"
  }

  private var gatewayTone: StatusTone {
    model.gatewaySummaryState?.tone ?? .neutral
  }

  private var lastUpdatedText: String? {
    guard let date = model.lastUpdated else { return nil }
    let formatter = RelativeDateTimeFormatter()
    formatter.unitsStyle = .abbreviated
    let now = Date()
    if date > now {
      return "Updated just now"
    }
    let delta = now.timeIntervalSince(date)
    if delta < 5 {
      return "Updated just now"
    }
    return "Updated \(formatter.localizedString(for: date, relativeTo: now))"
  }

  private var daemonIsRunning: Bool {
    model.daemonStatus?.resolvedLabel == .running
  }

  private var daemonIsStarting: Bool {
    model.daemonStatus?.resolvedLabel == .starting
  }

  private var canStartDaemon: Bool {
    !(daemonIsRunning || daemonIsStarting)
  }

  private var canStopDaemon: Bool {
    daemonIsRunning || daemonIsStarting
  }

  private var selectedProject: ProjectSummary? {
    guard case let .project(id) = model.selectedItem else { return nil }
    return model.projects.first(where: { $0.id == id })
  }

  private var stripLayoutSignature: String {
    let selectedKey: String = switch model.selectedItem {
    case .home:
      "home"
    case .runtime:
      "runtime"
    case .gateway:
      "gateway"
    case let .project(id):
      "project:\(id)"
    case .none:
      "none"
    }
    let projectAction = selectedProject.flatMap { project in
      model.projectLifecycleActions[project.id]
    }
    let actionKey: String = switch projectAction {
    case .starting:
      "starting"
    case .stopping:
      "stopping"
    case .none:
      "idle"
    }
    return "\(selectedKey)|\(selectorLabel)|\(actionKey)"
  }

  private func canStartProject(_ project: ProjectSummary) -> Bool {
    project.isRuntimeConfigured
      && (project.status == .stopped || project.status == .unknown || project.status == .unregistered)
  }

  private func canStopProject(_ project: ProjectSummary) -> Bool {
    project.isRuntimeConfigured && project.status == .running
  }

  private func devUrl(for project: ProjectSummary) -> URL? {
    guard let host = project.devHost?.trimmingCharacters(in: .whitespacesAndNewlines), !host.isEmpty else {
      return nil
    }
    if host.contains("://") {
      return URL(string: host)
    }
    return URL(string: "https://\(host)")
  }

  private func openTerminal(project: ProjectSummary, kind: TerminalDrawerModel.Kind) {
    NotificationCenter.default.post(
      name: .hackTerminalOpenRequested,
      object: nil,
      userInfo: [
        TerminalOpenRequest.projectIdKey: project.id,
        TerminalOpenRequest.kindKey: kind.rawValue
      ]
    )
  }

  private var selectorLabel: String {
    if case let .project(id) = model.selectedItem,
       let project = model.projects.first(where: { $0.id == id }) {
      return project.name
    }
    if model.selectedItem == .home {
      return "Dashboard"
    }
    if model.selectedItem == .gateway {
      return "Gateway"
    }
    return "System"
  }

  private var selectorIcon: String {
    switch model.selectedItem {
    case .home:
      return "square.grid.2x2"
    case .gateway:
      return "dot.radiowaves.left.and.right"
    case .runtime:
      return "gauge.with.dots.needle.50percent"
    case .project:
      return "cube.transparent"
    case .none:
      return "gauge.with.dots.needle.50percent"
    }
  }

  private func fallbackRuntimeStatus(for project: ProjectSummary) -> ProjectRuntimeStatus {
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

  private var selectorProjects: [ProjectSummary] {
    model.projects.sorted { lhs, rhs in
      let lhsActive = isProjectActive(lhs)
      let rhsActive = isProjectActive(rhs)
      if lhsActive != rhsActive {
        return lhsActive && !rhsActive
      }
      return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
    }
  }

  private var selectorExpandedWidth: CGFloat {
    max(stripContentWidth, 420)
  }

  private var selectorProjectListMaxHeight: CGFloat {
    320
  }

  private var selectorHeaderHeight: CGFloat {
    34
  }

  private var selectorProjectRowHeight: CGFloat {
    56
  }

  private var selectorPanelHeight: CGFloat {
    guard isSelectorExpanded else { return 0 }
    let rowsHeight = CGFloat(selectorProjects.count) * selectorProjectRowHeight
    let listPadding: CGFloat = 16
    let dividersHeight = CGFloat(max(0, selectorProjects.count - 1))
    let desired = rowsHeight + listPadding + dividersHeight + 1
    return min(selectorProjectListMaxHeight + 1, max(72, desired))
  }

  private var selectorContainerHeight: CGFloat {
    selectorHeaderHeight + selectorPanelHeight
  }

  private var selectorContainerAlignment: Alignment {
    if placement == .titlebar, isSelectorExpanded {
      return .topLeading
    }
    return .center
  }

  private var selectorExpandedCornerRadius: CGFloat {
    16
  }

  private var selectorCornerRadius: CGFloat {
    selectorUsesExpandedCorners ? selectorExpandedCornerRadius : 999
  }

  private var selectorOpenDelayNanoseconds: UInt64 {
    500_000_000
  }

  private var selectorCloseDelayNanoseconds: UInt64 {
    180_000_000
  }

  private var selectorListRevealDelayNanoseconds: UInt64 {
    170_000_000
  }

  private func toggleSelectorExpanded() {
    if isSelectorExpanded {
      collapseSelectorPanel()
      return
    }
    expandSelectorPanel()
  }

  private func updateSelectorExpansionFromHover() {
    guard placement == .titlebar else { return }
    let hoveringSelector = isSelectorHeaderHovered || isSelectorPanelHovered
    if hoveringSelector {
      selectorCollapseTask?.cancel()
      selectorCollapseTask = nil
      scheduleSelectorExpansion()
    } else {
      selectorExpandTask?.cancel()
      selectorExpandTask = nil
      scheduleSelectorCollapse()
    }
  }

  private func scheduleSelectorExpansion() {
    if isSelectorExpanded || selectorExpandTask != nil {
      return
    }
    selectorExpandTask = Task {
      try? await Task.sleep(nanoseconds: selectorOpenDelayNanoseconds)
      guard !Task.isCancelled else { return }
      await MainActor.run {
        selectorExpandTask = nil
        guard isSelectorHeaderHovered || isSelectorPanelHovered else { return }
        expandSelectorPanel()
      }
    }
  }

  private func expandSelectorPanel() {
    selectorExpandTask?.cancel()
    selectorExpandTask = nil
    selectorCollapseTask?.cancel()
    selectorCollapseTask = nil
    selectorListRevealTask?.cancel()
    selectorListRevealTask = nil
    selectorCornerResetTask?.cancel()
    selectorCornerResetTask = nil
    isSelectorListVisible = false

    withAnimation(.easeOut(duration: 0.08)) {
      selectorUsesExpandedCorners = true
    }
    withAnimation(.spring(response: 0.34, dampingFraction: 0.90)) {
      isSelectorExpanded = true
    }

    selectorListRevealTask = Task {
      try? await Task.sleep(nanoseconds: selectorListRevealDelayNanoseconds)
      guard !Task.isCancelled else { return }
      await MainActor.run {
        guard isSelectorExpanded else { return }
        withAnimation(.easeInOut(duration: 0.12)) {
          isSelectorListVisible = true
        }
        selectorListRevealTask = nil
      }
    }
  }

  private func scheduleSelectorCollapse() {
    if selectorCollapseTask != nil {
      return
    }
    selectorCollapseTask = Task {
      try? await Task.sleep(nanoseconds: selectorCloseDelayNanoseconds)
      guard !Task.isCancelled else { return }
      await MainActor.run {
        selectorCollapseTask = nil
        guard !(isSelectorHeaderHovered || isSelectorPanelHovered) else { return }
        collapseSelectorPanel()
      }
    }
  }

  private func collapseSelectorPanel() {
    selectorExpandTask?.cancel()
    selectorExpandTask = nil
    selectorCollapseTask?.cancel()
    selectorCollapseTask = nil
    selectorListRevealTask?.cancel()
    selectorListRevealTask = nil
    guard isSelectorExpanded else { return }
    hoveredSelectorProjectId = nil
    isSelectorListVisible = false
    withAnimation(.easeInOut(duration: 0.16)) {
      isSelectorExpanded = false
    }
    selectorCornerResetTask?.cancel()
    selectorCornerResetTask = Task {
      try? await Task.sleep(nanoseconds: 140_000_000)
      guard !Task.isCancelled else { return }
      await MainActor.run {
        guard !isSelectorExpanded else { return }
        withAnimation(.easeOut(duration: 0.08)) {
          selectorUsesExpandedCorners = false
        }
        selectorCornerResetTask = nil
      }
    }
  }

  private func updateStripContentWidth(_ width: CGFloat) {
    guard width.isFinite, width > 0 else { return }
    if abs(stripContentWidth - width) > 0.5 {
      stripContentWidth = width
    }
  }

  private func isProjectActive(_ project: ProjectSummary) -> Bool {
    project.status == .running || project.runtimeStatus == .running
  }

  private func selectorStatusLabel(for project: ProjectSummary) -> String {
    if isProjectActive(project) {
      return "Running"
    }
    if project.status == .missing {
      return "Missing"
    }
    if project.isRuntimeConfigured {
      return "Stopped"
    }
    return "Unknown"
  }

  private func selectorStatusColor(for project: ProjectSummary) -> Color {
    if isProjectActive(project) {
      return .green
    }
    if project.status == .missing {
      return .orange
    }
    return .secondary
  }

  private func selectorRowBackground(for project: ProjectSummary) -> Color {
    let isSelected: Bool = {
      guard case let .project(id) = model.selectedItem else { return false }
      return id == project.id
    }()
    let isHovered = hoveredSelectorProjectId == project.id
    if isSelected {
      return Color.primary.opacity(colorScheme == .dark ? 0.15 : 0.08)
    }
    if isHovered {
      return Color.primary.opacity(colorScheme == .dark ? 0.10 : 0.06)
    }
    return .clear
  }

  private var titlebarIconForeground: Color {
    dynamicColor(
      light: NSColor.black.withAlphaComponent(0.74),
      dark: NSColor.white.withAlphaComponent(0.92)
    )
  }

  private var titlebarIconStroke: Color {
    dynamicColor(
      light: NSColor.black.withAlphaComponent(0.12),
      dark: NSColor.white.withAlphaComponent(0.20)
    )
  }

  private var titlebarPillTint: Color {
    dynamicColor(
      light: NSColor.white.withAlphaComponent(0.56),
      dark: NSColor.black.withAlphaComponent(0.40)
    )
  }

  private var titlebarPillStroke: Color {
    dynamicColor(
      light: NSColor.black.withAlphaComponent(0.10),
      dark: NSColor.white.withAlphaComponent(0.14)
    )
  }

  private var titlebarPillShadow: Color {
    dynamicColor(
      light: NSColor.black.withAlphaComponent(0.12),
      dark: NSColor.black.withAlphaComponent(0.28)
    )
  }

  private var titlebarActionChipFill: Color {
    dynamicColor(
      light: NSColor.black.withAlphaComponent(0.05),
      dark: NSColor.white.withAlphaComponent(0.09)
    )
  }

  private func dynamicColor(light: NSColor, dark: NSColor) -> Color {
    Color(nsColor: NSColor(name: nil) { appearance in
      let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
      return isDark ? dark : light
    })
  }
}
