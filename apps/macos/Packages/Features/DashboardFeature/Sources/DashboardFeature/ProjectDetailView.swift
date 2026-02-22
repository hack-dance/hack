import AppKit
import SwiftUI

import HackDesktopModels

private enum ExecutionTargetMode: String, CaseIterable, Identifiable {
  case inherited = "Inherited"
  case fixedNode = "Fixed node"
  case providerProfile = "Provider profile"

  var id: String { rawValue }
}

struct ProjectDetailView: View {
  @Environment(DashboardModel.self) private var model
  @Environment(\.openURL) private var openURL
  @Environment(\.colorScheme) private var colorScheme
  @AppStorage("hackDesktop.preferences.defaultTerminal") private var preferredExternalTerminalRaw = TerminalIntegration.ExternalTerminalApp.terminal.rawValue
  @AppStorage("hackDesktop.sessions.preferredExternalTerminal") private var legacyPreferredExternalTerminalRaw = TerminalIntegration.ExternalTerminalApp.terminal.rawValue
  @AppStorage("hackDesktop.preferences.defaultIDE") private var preferredEditorRaw = EditorIntegration.EditorApp.cursor.rawValue
  @AppStorage("hackDesktop.preferences.defaultCodingAgent") private var preferredCodingAgentRaw = CodingAgentIntegration.AgentApp.codex.rawValue
  @AppStorage("hackDesktop.preferences.defaultCodingAgentBinaryPath") private var preferredCodingAgentBinaryPathRaw = ""

  let project: ProjectSummary
  @State private var showOverviewSidebar = true
  @State private var selectedService: String? = nil
  @State private var hoveredService: String? = nil
  @State private var isControlBarHovered = false
  @State private var hoveredControl: ProjectTab? = nil
  @State private var isStartHovered = false
  @State private var isStopHovered = false
  @State private var showInfoPanel = false
  @State private var expandedBranches: Set<String> = []
  @State private var showAddBranchSheet = false
  @State private var newBranchName = ""
  @State private var newBranchNote = ""
  @State private var executionTargetMode: ExecutionTargetMode = .inherited
  @State private var executionTargetNodeId = ""
  @State private var executionTargetProvider = ""
  @State private var executionTargetProfileId = ""
  @State private var executionTargetProfiles: [String] = []
  @State private var executionTargetProfileProviderById: [String: String] = [:]
  @State private var executionTargetNodes: [NodeRegistryRecord] = []
  @State private var executionTargetLoading = false
  @State private var executionTargetSaving = false
  @State private var executionTargetMessage = ""
  @State private var globalDefaultProvider = ""
  @State private var globalDefaultProfile = ""
  @State private var githubProjectProfile = ""
  @State private var githubDefaultProfile = ""
  @State private var githubProfileOptions: [String] = []
  @State private var githubProfilesById: [String: GitHubProfileSummary] = [:]
  @State private var githubResolvedProfile = ""
  @State private var githubResolvedStatus: GitHubStatusResponse? = nil
  @State private var githubProfileMessage = ""
  @State private var executionTargetReloadTask: Task<Void, Never>? = nil

  var body: some View {
    @Bindable var model = model
    VStack(alignment: .leading, spacing: 0) {
      projectPageHeader
      tabContent
        .id(effectiveTab)
        .transition(.opacity.combined(with: .move(edge: .trailing)))
        .animation(.easeInOut(duration: 0.2), value: effectiveTab)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
    .safeAreaInset(edge: .bottom, spacing: 0) {
      bottomControlBar
        .padding(.bottom, 18)
    }
    .onAppear {
      ensureSelectedTab()
      queueExecutionTargetReload()
    }
    .onChange(of: project.id) { _, _ in
      ensureSelectedTab()
      queueExecutionTargetReload()
    }
    .onChange(of: model.selectedProjectTab) { _, _ in
      ensureSelectedTab()
    }
    .onDisappear {
      executionTargetReloadTask?.cancel()
      executionTargetReloadTask = nil
    }
    .sheet(isPresented: $showAddBranchSheet) {
      addBranchSheet
    }
  }

  private var projectPageHeader: some View {
    VStack(alignment: .leading, spacing: 12) {
      headerBreadcrumb

      HStack(alignment: .top, spacing: 12) {
        VStack(alignment: .leading, spacing: 6) {
          HStack(spacing: 8) {
            Image(systemName: project.isRuntimeConfigured ? "cube.transparent" : "puzzlepiece")
              .font(.mono(.subheadline, weight: .semibold))
              .foregroundStyle(.secondary)
            Text(project.name)
              .font(.mono(.headline, weight: .semibold))
              .lineLimit(1)
              .truncationMode(.tail)
            RuntimeStatusBadge(status: runtimeStatus, runtimeHealthy: runtimeHealthy)
          }
          if let host = projectHost {
            Button {
              openServiceHost(host)
            } label: {
              Label(host, systemImage: "lock.shield")
                .font(.mono(.caption))
                .lineLimit(1)
                .truncationMode(.middle)
            }
            .buttonStyle(.plain)
            .linkHover()
          }
        }
        Spacer(minLength: 8)
        HStack(spacing: 8) {
          if isProjectLifecycleBusy {
            HStack(spacing: 6) {
              ProgressView()
                .controlSize(.small)
              Text(projectLifecycleLabel)
                .font(.mono(.caption))
                .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(
              Capsule(style: .continuous)
                .fill(colorScheme == .dark ? Color.white.opacity(0.08) : Color.black.opacity(0.04))
            )
          } else {
            if canStart {
              Button {
                Task { await model.startProject(project) }
              } label: {
                Label("Start", systemImage: "play.fill")
              }
              .buttonStyle(PressableIconButtonStyle())
            }

            if canStop {
              Button {
                Task { await model.stopProject(project) }
              } label: {
                Label("Stop", systemImage: "stop.fill")
              }
              .buttonStyle(PressableIconButtonStyle())
            }
          }

          if projectOpenPath != nil {
            openInProjectButton
            codingAgentQuickAccessButton
          }

          if !sessionEntries.isEmpty {
            sessionQuickAccessButton
          }
        }
      }

      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 8) {
          headerMetricPill("Services", value: "\(runningServiceCount)/\(serviceNames.count) running")
          headerMetricPill("Branches", value: "\(branchEntries.count)")
          headerMetricPill("Sessions", value: "\(sessionEntries.count)")
          if lifecycleSummary.hasEntries {
            headerMetricPill(
              "Startup",
              value: "\(lifecycleSummary.startupHookCount) hooks / \(lifecycleSummary.processCount) persistent"
            )
          }
          if project.supportsTickets {
            headerMetricPill("Tickets", value: "Enabled")
          }
        }
      }
    }
    .padding(.horizontal, 24)
    .padding(.top, 12)
    .padding(.bottom, 12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(projectHeaderShape.fill(projectHeaderBackground))
    .overlay(alignment: .bottom) {
      Rectangle()
        .fill(projectHeaderStrokeColor)
        .frame(height: 1)
    }
    .clipShape(projectHeaderShape)
    .padding(.bottom, 8)
  }

  private var headerBreadcrumb: some View {
    HStack(spacing: 6) {
      Text(project.name)
        .font(.mono(.caption, weight: .semibold))
        .foregroundStyle(.primary)
      Image(systemName: "chevron.right")
        .font(.mono(.caption2, weight: .semibold))
        .foregroundStyle(.secondary)
      Text(breadcrumbLabel(for: effectiveTab))
        .font(.mono(.caption, weight: .medium))
        .foregroundStyle(.secondary)
    }
    .lineLimit(1)
    .truncationMode(.tail)
  }

  @ViewBuilder
  private var tabContent: some View {
    switch effectiveTab {
    case .overview:
      overviewContent
    case .branches:
      branchesContent
    case .sessions:
      sessionsContent
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
        LazyVStack(alignment: .leading, spacing: 20) {
          if !project.isRuntimeConfigured {
            runtimeNotConfiguredCard
          }
          executionTargetSection
          githubProfileSection
          servicesSection
          if lifecycleSummary.hasEntries {
            lifecycleSection
          }
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

  private var executionTargetSection: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 10) {
        Image(systemName: "point.3.connected.trianglepath.dotted")
          .foregroundStyle(.secondary)
        Text("Execution target")
          .font(.mono(.headline, weight: .semibold))
        Spacer()
        if executionTargetLoading || executionTargetSaving {
          ProgressView()
            .controlSize(.small)
        }
      }
      .overlay(alignment: .bottom) {
        Rectangle()
          .fill(Color.white.opacity(0.08))
          .frame(height: 1)
          .offset(y: 8)
      }

      HStack(spacing: 8) {
        StatusPill(text: executionTargetSourceLabel, tone: .neutral)
        if !globalDefaultProfile.isEmpty {
          StatusPill(text: "Global profile: \(globalDefaultProfile)", tone: .neutral)
        } else if !globalDefaultProvider.isEmpty {
          StatusPill(text: "Global provider: \(globalDefaultProvider)", tone: .neutral)
        }
      }

      Picker("Target mode", selection: $executionTargetMode) {
        ForEach(ExecutionTargetMode.allCases) { mode in
          Text(mode.rawValue).tag(mode)
        }
      }
      .pickerStyle(.segmented)

      if executionTargetMode == .fixedNode {
        Picker("Node", selection: $executionTargetNodeId) {
          Text("Select node").tag("")
          ForEach(executionTargetNodes, id: \.id) { node in
            Text(node.name).tag(node.id)
          }
        }
        .pickerStyle(.menu)
      }

      if executionTargetMode == .providerProfile {
        TextField("Provider", text: $executionTargetProvider)
          .textFieldStyle(.roundedBorder)
        Picker("Profile", selection: $executionTargetProfileId) {
          Text("No profile").tag("")
          ForEach(executionTargetProfiles, id: \.self) { profile in
            Text(profile).tag(profile)
          }
        }
        .pickerStyle(.menu)
        .onChange(of: executionTargetProfileId) { _, profileId in
          guard let provider = executionTargetProfileProviderById[profileId] else {
            return
          }
          executionTargetProvider = provider
        }
      }

      if !executionTargetMessage.isEmpty {
        Text(executionTargetMessage)
          .font(.mono(.caption2))
          .foregroundStyle(Color.orange)
      }

      HStack(spacing: 8) {
        Button {
          Task { await persistExecutionTarget() }
        } label: {
          Label("Save target", systemImage: "square.and.arrow.down")
        }
        .buttonStyle(PressableIconButtonStyle())
        .disabled(executionTargetLoading || executionTargetSaving)

        Button {
          executionTargetMode = .inherited
          executionTargetNodeId = ""
          executionTargetProvider = ""
          executionTargetProfileId = ""
          Task { await persistExecutionTarget() }
        } label: {
          Label("Reset to inherited", systemImage: "arrow.uturn.backward")
        }
        .buttonStyle(PressableIconButtonStyle())
        .disabled(executionTargetLoading || executionTargetSaving)

        Spacer()
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

  private var githubProfileSection: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 10) {
        Image(systemName: "person.2.badge.gearshape")
          .foregroundStyle(.secondary)
        Text("GitHub profile")
          .font(.mono(.headline, weight: .semibold))
        Spacer()
      }
      .overlay(alignment: .bottom) {
        Rectangle()
          .fill(Color.white.opacity(0.08))
          .frame(height: 1)
          .offset(y: 8)
      }

      HStack(spacing: 8) {
        StatusPill(
          text: githubProjectProfile.isEmpty ? "Inherited profile" : "Project override",
          tone: githubProjectProfile.isEmpty ? .neutral : .good
        )
        if !githubDefaultProfile.isEmpty {
          StatusPill(text: "Global default: \(githubDefaultProfile)", tone: .neutral)
        }
        if !githubResolvedProfile.isEmpty {
          StatusPill(text: "Effective: \(githubResolvedProfile)", tone: .good)
        }
        if let status = githubResolvedStatus {
          StatusPill(
            text: status.tokenResolved ? "Token resolved" : "Token missing",
            tone: status.tokenResolved ? .good : .warn
          )
        }
      }

      if let resolvedSummary = resolvedGitHubProfileSummary {
        VStack(alignment: .leading, spacing: 4) {
          if let account = resolvedSummary.accountLogin, !account.isEmpty {
            Text("Account: \(account)\(resolvedSummary.accountName.map { " (\($0))" } ?? "")")
              .font(.mono(.caption2))
              .foregroundStyle(.secondary)
          }
          if let installation = resolvedSummary.installationId, !installation.isEmpty {
            Text("Installation: \(installation)")
              .font(.mono(.caption2))
              .foregroundStyle(.secondary)
          }
        }
      }

      if let status = githubResolvedStatus {
        VStack(alignment: .leading, spacing: 4) {
          if let source = status.tokenSource, !source.isEmpty {
            Text("Token source: \(source)")
              .font(.mono(.caption2))
              .foregroundStyle(.tertiary)
          }
          if let expiresAt = status.tokenExpiresAt, !expiresAt.isEmpty {
            Text("Token expires: \(expiresAt)")
              .font(.mono(.caption2))
              .foregroundStyle(.tertiary)
          }
          if let error = status.error, !error.isEmpty {
            Text(error)
              .font(.mono(.caption2))
              .foregroundStyle(Color.orange)
          }
        }
      }

      Picker("Profile", selection: $githubProjectProfile) {
        Text("Inherited").tag("")
        ForEach(githubProfileOptions, id: \.self) { profile in
          Text(profile).tag(profile)
        }
      }
      .pickerStyle(.menu)

      Text(
        "This maps to `controlPlane.routing.overrides.github.profile`. Dispatch `--pr` uses this when no `--github-profile` flag is provided."
      )
      .font(.mono(.caption2))
      .foregroundStyle(.secondary)

      if !githubProfileMessage.isEmpty {
        Text(githubProfileMessage)
          .font(.mono(.caption2))
          .foregroundStyle(Color.orange)
      }

      HStack(spacing: 8) {
        Button {
          Task { await persistGitHubProfileOverride() }
        } label: {
          Label("Save GitHub profile", systemImage: "square.and.arrow.down")
        }
        .buttonStyle(PressableIconButtonStyle())
        .disabled(executionTargetLoading || executionTargetSaving)

        Button {
          githubProjectProfile = ""
          Task { await persistGitHubProfileOverride() }
        } label: {
          Label("Use inherited", systemImage: "arrow.uturn.backward")
        }
        .buttonStyle(PressableIconButtonStyle())
        .disabled(executionTargetLoading || executionTargetSaving)

        Spacer()
      }
    }
  }

  private var branchesContent: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 20) {
        branchesSection
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

  private var sessionsContent: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 20) {
        sessionsSection
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

  private var branchesSection: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 10) {
        Image(systemName: "arrow.triangle.branch")
          .foregroundStyle(.secondary)
        Text("Branch Instances")
          .font(.mono(.headline, weight: .semibold))
        Spacer()
        Button {
          showAddBranchSheet = true
        } label: {
          Label("New branch", systemImage: "plus")
            .font(.mono(.caption))
        }
        .buttonStyle(PressableIconButtonStyle())
      }
      .overlay(alignment: .bottom) {
        Rectangle()
          .fill(Color.white.opacity(0.08))
          .frame(height: 1)
          .offset(y: 8)
      }

      if branchEntries.isEmpty {
        Text("No branch instances found.")
          .font(.mono(.subheadline))
          .foregroundStyle(.secondary)
      } else {
        LazyVStack(alignment: .leading, spacing: 10) {
          ForEach(branchEntries, id: \.branch) { entry in
            branchRow(entry)
            Divider()
              .opacity(0.2)
          }
        }
      }
    }
  }

  private var sessionsSection: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 10) {
        Image(systemName: "rectangle.3.group.bubble.left")
          .foregroundStyle(.secondary)
        Text("Sessions")
          .font(.mono(.headline, weight: .semibold))
        Spacer()
        Button {
          Task { await model.startSession(for: project) }
        } label: {
          Label("Start session", systemImage: "plus")
            .font(.mono(.caption))
        }
        .buttonStyle(PressableIconButtonStyle())
      }
      .overlay(alignment: .bottom) {
        Rectangle()
          .fill(Color.white.opacity(0.08))
          .frame(height: 1)
          .offset(y: 8)
      }

      if sessionEntries.isEmpty {
        VStack(alignment: .leading, spacing: 6) {
          Text("No active sessions found for this project.")
            .font(.mono(.subheadline))
            .foregroundStyle(.secondary)
          Text("Run `hack session start \(project.name)` in a terminal to create one.")
            .font(.mono(.caption))
            .foregroundStyle(.tertiary)
        }
      } else {
        LazyVStack(alignment: .leading, spacing: 10) {
          ForEach(sessionEntries, id: \.id) { session in
            sessionRow(session)
            Divider()
              .opacity(0.2)
          }
        }
      }
    }
  }

  private var addBranchSheet: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("Create Branch Instance")
        .font(.mono(.headline, weight: .semibold))

      TextField("Branch name (e.g. fix-seat-geometry)", text: $newBranchName)
        .textFieldStyle(.roundedBorder)

      TextField("Optional note", text: $newBranchNote)
        .textFieldStyle(.roundedBorder)

      HStack {
        Spacer()
        Button("Cancel") {
          resetBranchDraft()
          showAddBranchSheet = false
        }
        Button("Create & Start") {
          let branch = newBranchName.trimmingCharacters(in: .whitespacesAndNewlines)
          guard !branch.isEmpty else { return }
          let note = newBranchNote.trimmingCharacters(in: .whitespacesAndNewlines)
          Task {
            let didAdd = await model.addBranch(
              for: project,
              name: branch,
              note: note.isEmpty ? nil : note
            )
            if didAdd {
              await model.startBranch(for: project, branch: branch)
            }
          }
          resetBranchDraft()
          showAddBranchSheet = false
        }
        .keyboardShortcut(.defaultAction)
        .disabled(newBranchName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }
    .padding(18)
    .frame(minWidth: 420)
  }

  private func resetBranchDraft() {
    newBranchName = ""
    newBranchNote = ""
  }

  private var branchEntries: [BranchRuntime] {
    (project.branchRuntime ?? []).sorted { $0.branch.localizedCaseInsensitiveCompare($1.branch) == .orderedAscending }
  }

  private var sessionEntries: [ProjectSessionSummary] {
    (project.sessions ?? []).sorted { lhs, rhs in
      if lhs.source != rhs.source {
        return lhs.source == .hack
      }
      return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
    }
  }

  private var runningServiceCount: Int {
    serviceNames.reduce(into: 0) { count, name in
      let state = serviceStatus(for: name).runState
      if state == .running || state == .partial {
        count += 1
      }
    }
  }

  private var projectHost: String? {
    let host = project.devHost?.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let host, !host.isEmpty else { return nil }
    return host
  }

  private func branchRow(_ entry: BranchRuntime) -> some View {
    let status = branchStatus(for: entry.runtime)
    return VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 10) {
        Button {
          toggleBranchExpansion(entry.branch)
        } label: {
          Image(systemName: expandedBranches.contains(entry.branch) ? "chevron.down" : "chevron.right")
            .font(.mono(.caption, weight: .semibold))
            .foregroundStyle(.secondary)
        }
        .buttonStyle(.plain)

        Text(entry.branch)
          .font(.mono(.subheadline, weight: .semibold))

        Spacer()
        Text(status.label)
          .font(.mono(.caption))
          .foregroundStyle(status.color)
      }

      HStack(spacing: 10) {
        Text("\(status.runningServices)/\(status.totalServices) services running")
          .font(.mono(.caption2))
          .foregroundStyle(.secondary)
        if let branchHost = branchHost(for: entry.branch) {
          Button {
            openServiceHost(branchHost)
          } label: {
            Text(branchHost)
              .font(.mono(.caption2))
          }
          .buttonStyle(.plain)
          .linkHover()
        }
        Spacer()
      }

      HStack(spacing: 8) {
        if status.runningServices > 0 {
          Button("Stop") {
            Task { await model.stopBranch(for: project, branch: entry.branch) }
          }
          .buttonStyle(PressableIconButtonStyle())
        } else {
          Button("Start") {
            Task { await model.startBranch(for: project, branch: entry.branch) }
          }
          .buttonStyle(PressableIconButtonStyle())
        }

        Button("Logs") {
          model.showLogs(for: project, branch: entry.branch)
        }
        .buttonStyle(PressableIconButtonStyle())

        Button("Remove Alias") {
          Task { await model.removeBranch(for: project, name: entry.branch) }
        }
        .buttonStyle(PressableIconButtonStyle())
      }

      if expandedBranches.contains(entry.branch) {
        VStack(alignment: .leading, spacing: 6) {
          ForEach(entry.runtime.services.sorted(by: { $0.service < $1.service }), id: \.service) { service in
            let running = service.containers.filter { $0.state.lowercased() == "running" }.count
            Text("\(service.service): \(running)/\(service.containers.count) running")
              .font(.mono(.caption2))
              .foregroundStyle(.tertiary)
          }
        }
        .padding(.top, 2)
      }
    }
    .padding(.vertical, 8)
    .padding(.horizontal, 4)
  }

  private func sessionRow(_ session: ProjectSessionSummary) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 10) {
        Text(session.name)
          .font(.mono(.subheadline, weight: .semibold))
        Spacer()
        BadgePill(label: session.backend.rawValue, tint: .secondary)
        BadgePill(label: session.source == .hack ? "hack" : "external", tint: .secondary)
        BadgePill(label: session.attached ? "attached" : "detached", tint: session.attached ? .green : .orange)
      }

      HStack(spacing: 10) {
        if let path = session.path, !path.isEmpty {
          Text(path)
            .font(.mono(.caption2))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.middle)
        } else {
          Text("Path unavailable")
            .font(.mono(.caption2))
            .foregroundStyle(.tertiary)
        }
        Spacer()
        if let windows = session.windows {
          Text("\(windows) window\(windows == 1 ? "" : "s")")
            .font(.mono(.caption2))
            .foregroundStyle(.secondary)
        }
      }

      HStack(spacing: 8) {
        Button("Attach (Drawer)") {
          openTerminal(
            kind: .shell,
            command: attachCommand(for: session),
            title: "\(session.name) (attached)"
          )
        }
        .buttonStyle(PressableIconButtonStyle())

        Menu {
          ForEach(installedExternalTerminalApps, id: \.self) { terminalApp in
            Button {
              preferredExternalTerminalRaw = terminalApp.rawValue
              legacyPreferredExternalTerminalRaw = terminalApp.rawValue
              openSession(session, terminalApp: terminalApp)
            } label: {
              Label(
                "Open in \(terminalApp.displayName)",
                systemImage: terminalApp == preferredExternalTerminal ? "checkmark.circle.fill" : "circle"
              )
            }
          }
        } label: {
          Label("Open In", systemImage: "arrow.up.right.square")
        }
        .buttonStyle(PressableIconButtonStyle())

        Button("Stop") {
          Task { await model.stopSession(name: session.name) }
        }
        .buttonStyle(PressableIconButtonStyle())
      }
    }
    .padding(.vertical, 8)
    .padding(.horizontal, 4)
  }

  private func toggleBranchExpansion(_ branch: String) {
    if expandedBranches.contains(branch) {
      expandedBranches.remove(branch)
    } else {
      expandedBranches.insert(branch)
    }
  }

  private func branchHost(for branch: String) -> String? {
    guard let host = project.devHost, !host.isEmpty else { return nil }
    return "\(branch).\(host)"
  }

  private func branchStatus(for runtime: RuntimeProject) -> (
    label: String,
    color: Color,
    runningServices: Int,
    totalServices: Int
  ) {
    let totalServices = runtime.services.count
    let runningServices = runtime.services.reduce(into: 0) { count, service in
      if service.containers.contains(where: { $0.state.lowercased() == "running" }) {
        count += 1
      }
    }

    if totalServices == 0 {
      return ("No services", .secondary, runningServices, totalServices)
    }
    if runningServices == 0 {
      return ("Stopped", .orange, runningServices, totalServices)
    }
    if runningServices == totalServices {
      return ("Running", .green, runningServices, totalServices)
    }
    return ("Partial", .orange, runningServices, totalServices)
  }

  private var featuresList: [String] {
    project.features ?? project.extensionsEnabled ?? []
  }

  private var executionTargetSourceLabel: String {
    switch executionTargetMode {
    case .inherited:
      return "Inherited from global defaults"
    case .fixedNode:
      return "Project fixed node"
    case .providerProfile:
      return "Project provider profile"
    }
  }

  private var resolvedGitHubProfileSummary: GitHubProfileSummary? {
    let resolved = githubResolvedProfile.trimmingCharacters(in: .whitespacesAndNewlines)
    if resolved.isEmpty {
      return nil
    }
    return githubProfilesById[resolved]
  }

  /**
   Reload project execution target state and provider profile options.
   */
  private func reloadExecutionTargetState() async {
    if Task.isCancelled {
      return
    }
    executionTargetLoading = true
    defer { executionTargetLoading = false }

    async let nodeList = model.listNodes()
    async let projectNodeId = model.getProjectConfig(
      for: project,
      key: "controlPlane.nodeId"
    )
    async let routingProvider = model.getProjectConfig(
      for: project,
      key: "controlPlane.routing.provider"
    )
    async let routingProfile = model.getProjectConfig(
      for: project,
      key: "controlPlane.routing.profile"
    )
    async let projectGitHubProfile = model.getProjectConfig(
      for: project,
      key: "controlPlane.routing.overrides.github.profile"
    )
    async let defaultProvider = model.getGlobalConfig(
      key: "controlPlane.providers.defaultProvider"
    )
    async let defaultProfile = model.getGlobalConfig(
      key: "controlPlane.providers.defaultProfile"
    )
    async let profilesRaw = model.getGlobalConfig(
      key: "controlPlane.providers.profiles"
    )
    async let defaultGitHubProfile = model.getGlobalConfig(
      key: "controlPlane.extensions[\"dance.hack.github\"].config.defaultProfile"
    )
    async let githubProfiles = model.inspectGitHubProfiles()

    let resolvedNodeList = await nodeList
    let resolvedProjectNodeId = await projectNodeId
    let resolvedRoutingProvider = await routingProvider
    let resolvedRoutingProfile = await routingProfile
    let resolvedProjectGitHubProfile = await projectGitHubProfile
    let resolvedDefaultProvider = await defaultProvider
    let resolvedDefaultProfile = await defaultProfile
    let resolvedProfilesRaw = await profilesRaw
    let resolvedDefaultGitHubProfile = await defaultGitHubProfile
    let resolvedGitHubProfiles = await githubProfiles

    if Task.isCancelled {
      return
    }

    executionTargetNodes = resolvedNodeList?.nodes ?? []
    let projectNodeIdValue = (resolvedProjectNodeId ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    executionTargetNodeId = projectNodeIdValue
    executionTargetProvider = (resolvedRoutingProvider ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    executionTargetProfileId = (resolvedRoutingProfile ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    globalDefaultProvider = (resolvedDefaultProvider ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    globalDefaultProfile = (resolvedDefaultProfile ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    githubProjectProfile = (resolvedProjectGitHubProfile ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let fallbackDefaultGitHubProfile = (resolvedDefaultGitHubProfile ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    githubDefaultProfile = resolvedGitHubProfiles?.defaultProfile ?? fallbackDefaultGitHubProfile
    githubProfilesById = mapGitHubProfilesById(response: resolvedGitHubProfiles)
    githubProfileOptions = (resolvedGitHubProfiles?.profiles ?? [])
      .map(\.id)
      .sorted { lhs, rhs in
        lhs.localizedCaseInsensitiveCompare(rhs) == .orderedAscending
      }
    let resolvedGitHubProfile = githubProjectProfile.isEmpty
      ? githubDefaultProfile
      : githubProjectProfile
    githubResolvedProfile = resolvedGitHubProfile
    githubResolvedStatus = await model.inspectGitHubStatus(
      profileId: resolvedGitHubProfile.isEmpty ? nil : resolvedGitHubProfile
    )

    let profileParse = parseProviderProfiles(raw: resolvedProfilesRaw)
    executionTargetProfiles = profileParse.ids
    executionTargetProfileProviderById = profileParse.providerById

    if executionTargetNodeId.isEmpty {
      if !executionTargetProfileId.isEmpty || !executionTargetProvider.isEmpty {
        executionTargetMode = .providerProfile
      } else {
        executionTargetMode = .inherited
      }
    } else {
      executionTargetMode = .fixedNode
    }

    if executionTargetProvider.isEmpty,
      let fromProfile = executionTargetProfileProviderById[executionTargetProfileId]
    {
      executionTargetProvider = fromProfile
    }
    executionTargetMessage = ""
    githubProfileMessage = ""
  }

  private func queueExecutionTargetReload() {
    executionTargetReloadTask?.cancel()
    executionTargetReloadTask = Task {
      await reloadExecutionTargetState()
    }
  }

  /**
   Persist execution-target settings into the project-scoped controlPlane config.
   */
  private func persistExecutionTarget() async {
    executionTargetSaving = true
    defer { executionTargetSaving = false }

    let providerFromProfile = executionTargetProfileProviderById[
      executionTargetProfileId
    ]
    let effectiveProvider = executionTargetProvider
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .isEmpty
      ? (providerFromProfile ?? "")
      : executionTargetProvider.trimmingCharacters(in: .whitespacesAndNewlines)
    let effectiveProfile = executionTargetProfileId
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let effectiveNodeId = executionTargetNodeId
      .trimmingCharacters(in: .whitespacesAndNewlines)

    let writes: [(String, String)]
    switch executionTargetMode {
    case .inherited:
      writes = [
        ("controlPlane.nodeId", ""),
        ("controlPlane.routing.provider", ""),
        ("controlPlane.routing.profile", ""),
      ]
    case .fixedNode:
      guard !effectiveNodeId.isEmpty else {
        executionTargetMessage = "Select a node before saving fixed-node mode."
        return
      }
      writes = [
        ("controlPlane.nodeId", effectiveNodeId),
        ("controlPlane.routing.provider", ""),
        ("controlPlane.routing.profile", ""),
      ]
    case .providerProfile:
      guard !effectiveProvider.isEmpty else {
        executionTargetMessage = "Provider is required for provider-profile mode."
        return
      }
      writes = [
        ("controlPlane.nodeId", ""),
        ("controlPlane.routing.provider", effectiveProvider),
        ("controlPlane.routing.profile", effectiveProfile),
      ]
    }

    for (key, value) in writes {
      let didSave = await model.setProjectConfig(
        for: project,
        key: key,
        value: value
      )
      if !didSave {
        executionTargetMessage = "Failed to save \(key)."
        return
      }
    }

    executionTargetMessage = "Execution target saved."
    await model.refresh()
    queueExecutionTargetReload()
  }

  private func parseProviderProfiles(raw: String?) -> (
    ids: [String],
    providerById: [String: String]
  ) {
    guard
      let raw,
      let data = raw.data(using: .utf8),
      let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
      return ([], [:])
    }

    let ids = parsed.keys.sorted { lhs, rhs in
      lhs.localizedCaseInsensitiveCompare(rhs) == .orderedAscending
    }
    var providerById: [String: String] = [:]
    for id in ids {
      guard
        let profile = parsed[id] as? [String: Any],
        let provider = profile["provider"] as? String
      else {
        continue
      }
      providerById[id] = provider
    }
    return (ids, providerById)
  }

  private func mapGitHubProfilesById(response: GitHubProfilesResponse?) -> [String: GitHubProfileSummary] {
    guard let response else {
      return [:]
    }
    return response.profiles.reduce(into: [:]) { partialResult, profile in
      partialResult[profile.id] = profile
    }
  }

  private func persistGitHubProfileOverride() async {
    executionTargetSaving = true
    defer { executionTargetSaving = false }

    let trimmed = githubProjectProfile
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let didSave = await model.setProjectConfig(
      for: project,
      key: "controlPlane.routing.overrides.github.profile",
      value: trimmed
    )
    if !didSave {
      githubProfileMessage = "Failed to save GitHub profile override."
      return
    }
    githubProfileMessage = trimmed.isEmpty
      ? "GitHub profile override cleared (inherited)."
      : "GitHub profile override saved."
    await model.refresh()
    queueExecutionTargetReload()
  }

  private struct LifecycleSummaryCounts {
    let startupHookCount: Int
    let shutdownHookCount: Int
    let processCount: Int
    let persistentHookCount: Int

    var persistentCount: Int {
      persistentHookCount + processCount
    }

    var hasEntries: Bool {
      startupHookCount > 0 || shutdownHookCount > 0 || processCount > 0
    }
  }

  private var lifecycleSummary: LifecycleSummaryCounts {
    let lifecycle = project.lifecycle
    let persistentHooks = lifecycleHooks.filter { $0.command.persistent == true }
    return LifecycleSummaryCounts(
      startupHookCount: (lifecycle?.upBefore.count ?? 0) + (lifecycle?.upAfter.count ?? 0),
      shutdownHookCount: (lifecycle?.downBefore.count ?? 0) + (lifecycle?.downAfter.count ?? 0),
      processCount: lifecycle?.processes.count ?? 0,
      persistentHookCount: persistentHooks.count
    )
  }

  private var lifecycleHooks: [(phase: String, command: ProjectLifecycleCommandSummary)] {
    guard let lifecycle = project.lifecycle else { return [] }
    return [
      lifecycle.upBefore.map { (phase: "up.before", command: $0) },
      lifecycle.upAfter.map { (phase: "up.after", command: $0) },
      lifecycle.downBefore.map { (phase: "down.before", command: $0) },
      lifecycle.downAfter.map { (phase: "down.after", command: $0) }
    ].flatMap { $0 }
  }

  private var lifecycleSection: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 10) {
        Image(systemName: "bolt.horizontal")
          .foregroundStyle(.secondary)
        Text("Startup & Lifecycle")
          .font(.mono(.headline, weight: .semibold))
        Spacer()
        Button("All lifecycle logs") {
          openLifecycleLogs(service: nil, title: "lifecycle logs")
        }
        .buttonStyle(PressableIconButtonStyle())
      }
      .overlay(alignment: .bottom) {
        Rectangle()
          .fill(Color.white.opacity(0.08))
          .frame(height: 1)
          .offset(y: 8)
      }

      HStack(spacing: 8) {
        BadgePill(label: "\(lifecycleSummary.startupHookCount) startup hooks", tint: .secondary)
        BadgePill(label: "\(lifecycleSummary.shutdownHookCount) shutdown hooks", tint: .secondary)
        BadgePill(label: "\(lifecycleSummary.persistentCount) persistent", tint: .secondary)
      }

      if let lifecycle = project.lifecycle, !lifecycle.processes.isEmpty {
        VStack(alignment: .leading, spacing: 8) {
          sectionHeader("Persistent processes")
          ForEach(Array(lifecycle.processes.enumerated()), id: \.offset) { _, process in
            lifecycleProcessRow(process)
            Divider()
              .opacity(0.2)
          }
        }
      }

      if !lifecycleHooks.isEmpty {
        VStack(alignment: .leading, spacing: 8) {
          sectionHeader("Hooks")
          ForEach(Array(lifecycleHooks.enumerated()), id: \.offset) { _, entry in
            lifecycleHookRow(phase: entry.phase, command: entry.command)
            Divider()
              .opacity(0.2)
          }
        }
      }
    }
  }

  private func lifecycleProcessRow(_ process: ProjectLifecycleProcessSummary) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 8) {
        Text(process.name)
          .font(.mono(.caption, weight: .semibold))
        BadgePill(label: "persistent", tint: .green)
        BadgePill(label: process.service, tint: .secondary)
        Spacer()
        Button("Tail logs") {
          openLifecycleLogs(service: process.service, title: "\(process.name) logs")
        }
        .buttonStyle(PressableIconButtonStyle())
      }
      Text(process.command)
        .font(.mono(.caption2))
        .foregroundStyle(.secondary)
        .textSelection(.enabled)
      if let cwd = process.cwd, !cwd.isEmpty {
        Text("cwd: \(cwd)")
          .font(.mono(.caption2))
          .foregroundStyle(.tertiary)
          .textSelection(.enabled)
      }
    }
    .padding(.vertical, 4)
  }

  private func lifecycleHookRow(
    phase: String,
    command: ProjectLifecycleCommandSummary
  ) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 8) {
        Text(command.name ?? command.service)
          .font(.mono(.caption, weight: .semibold))
        BadgePill(label: phase, tint: .secondary)
        if command.persistent == true {
          BadgePill(label: "persistent", tint: .green)
        }
        Spacer()
        Button("Show output") {
          openLifecycleLogs(service: command.service, title: "\(command.service) output")
        }
        .buttonStyle(PressableIconButtonStyle())
      }
      Text(command.command)
        .font(.mono(.caption2))
        .foregroundStyle(.secondary)
        .textSelection(.enabled)
      if let cwd = command.cwd, !cwd.isEmpty {
        Text("cwd: \(cwd)")
          .font(.mono(.caption2))
          .foregroundStyle(.tertiary)
          .textSelection(.enabled)
      }
    }
    .padding(.vertical, 4)
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
    project.isRuntimeConfigured
      && !isProjectLifecycleBusy
      && (project.status == .stopped || project.status == .unknown || project.status == .unregistered)
  }

  private var canStop: Bool {
    project.isRuntimeConfigured && !isProjectLifecycleBusy && project.status == .running
  }

  private var projectLifecycleAction: ProjectLifecycleAction? {
    model.projectLifecycleActions[project.id]
  }

  private var isProjectLifecycleBusy: Bool {
    projectLifecycleAction != nil
  }

  private var projectLifecycleLabel: String {
    switch projectLifecycleAction {
    case .starting:
      return "Starting…"
    case .stopping:
      return "Stopping…"
    case .none:
      return "Working…"
    }
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

  private enum ServiceRunState {
    case running
    case partial
    case stopped
    case notRunning
  }

  private struct ServiceStatus {
    let runState: ServiceRunState
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
    return Array(Set(defined).union(runtime).union(hosts)).sorted { lhs, rhs in
      let lhsStatus = serviceStatus(for: lhs)
      let rhsStatus = serviceStatus(for: rhs)
      let lhsRank = serviceSortRank(lhsStatus.runState)
      let rhsRank = serviceSortRank(rhsStatus.runState)
      if lhsRank == rhsRank {
        return lhs.localizedCaseInsensitiveCompare(rhs) == .orderedAscending
      }
      return lhsRank < rhsRank
    }
  }

  private func serviceSortRank(_ state: ServiceRunState) -> Int {
    switch state {
    case .running:
      return 0
    case .partial:
      return 1
    case .stopped:
      return 2
    case .notRunning:
      return 3
    }
  }

  private func serviceStatus(for service: String) -> ServiceStatus {
    guard let runtime = runtimeServicesByName[service] else {
      return ServiceStatus(
        runState: .notRunning,
        label: "Not running",
        color: .secondary,
        detail: nil,
        urlLabel: serviceHostLabel(for: service)
      )
    }
    let total = runtime.containers.count
    let running = runtime.containers.filter { $0.state.lowercased() == "running" }.count
    let ports = runtime.containers.first(where: { !$0.ports.isEmpty })?.ports
    let detail = ports?.isEmpty == false ? ports : nil
    if total == 0 {
      return ServiceStatus(
        runState: .notRunning,
        label: "Not running",
        color: .secondary,
        detail: detail,
        urlLabel: serviceHostLabel(for: service)
      )
    }
    if running == total {
      return ServiceStatus(
        runState: .running,
        label: "Running",
        color: .green,
        detail: detail,
        urlLabel: serviceHostLabel(for: service)
      )
    }
    if running > 0 {
      return ServiceStatus(
        runState: .partial,
        label: "\(running)/\(total) running",
        color: .orange,
        detail: detail,
        urlLabel: serviceHostLabel(for: service)
      )
    }
    return ServiceStatus(
      runState: .stopped,
      label: "Stopped",
      color: .orange,
      detail: detail,
      urlLabel: serviceHostLabel(for: service)
    )
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
      HStack(spacing: 8) {
        Text(service)
          .font(.mono(.subheadline, weight: .semibold))
        Spacer()
        Button("Tail logs") {
          openLifecycleLogs(service: service, title: "\(service) logs")
        }
        .buttonStyle(PressableIconButtonStyle())
      }
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
      if runtime != nil {
        let runningCount = containers.filter { $0.state.lowercased() == "running" }.count
        DetailRows(rows: [
          DetailRowItem(label: "Containers", value: "\(containers.count)"),
          DetailRowItem(label: "Running", value: "\(runningCount)")
        ])
        ForEach(containers, id: \.id) { container in
          VStack(alignment: .leading, spacing: 6) {
            Text(container.name)
              .font(.mono(.caption, weight: .semibold))

            DetailRows(
              rows: containerOverviewRows(container),
              labelWidth: 96
            )

            if let networks = container.networks, !networks.isEmpty {
              VStack(alignment: .leading, spacing: 4) {
                Text("Networks")
                  .font(.mono(.caption2, weight: .semibold))
                  .foregroundStyle(.secondary)
                ForEach(networks, id: \.name) { network in
                  Text(networkSummary(network))
                    .font(.mono(.caption2))
                    .foregroundStyle(.tertiary)
                    .textSelection(.enabled)
                }
              }
            }

            if let mounts = container.mounts, !mounts.isEmpty {
              VStack(alignment: .leading, spacing: 4) {
                Text("Mounts")
                  .font(.mono(.caption2, weight: .semibold))
                  .foregroundStyle(.secondary)
                ForEach(Array(mounts.enumerated()), id: \.offset) { _, mount in
                  Text(mountSummary(mount))
                    .font(.mono(.caption2))
                    .foregroundStyle(.tertiary)
                    .textSelection(.enabled)
                }
              }
            }

            if let labels = container.labels, !labels.isEmpty {
              VStack(alignment: .leading, spacing: 4) {
                Text("Labels")
                  .font(.mono(.caption2, weight: .semibold))
                  .foregroundStyle(.secondary)
                ForEach(sortedLabels(labels), id: \.key) { entry in
                  Text("\(entry.key)=\(entry.value)")
                    .font(.mono(.caption2))
                    .foregroundStyle(.tertiary)
                    .textSelection(.enabled)
                }
              }
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

  private func containerOverviewRows(_ container: RuntimeContainer) -> [DetailRowItem] {
    var rows = [
      DetailRowItem(label: "ID", value: shortContainerID(container.id)),
      DetailRowItem(label: "Status", value: container.status),
      DetailRowItem(label: "State", value: container.state)
    ]
    if let image = container.image, !image.isEmpty {
      rows.append(DetailRowItem(label: "Image", value: image))
    }
    if !container.ports.isEmpty {
      rows.append(DetailRowItem(label: "Ports", value: container.ports))
    }
    if let workingDir = container.workingDir, !workingDir.isEmpty {
      rows.append(DetailRowItem(label: "Workdir", value: workingDir))
    }
    return rows
  }

  private func shortContainerID(_ id: String) -> String {
    let trimmed = id.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.count > 12 else { return trimmed }
    return String(trimmed.prefix(12))
  }

  private func networkSummary(_ network: RuntimeContainerNetwork) -> String {
    var parts: [String] = [network.name]
    if let ipAddress = network.ipAddress, !ipAddress.isEmpty {
      parts.append(ipAddress)
    }
    if let aliases = network.aliases, !aliases.isEmpty {
      parts.append("aliases: \(aliases.joined(separator: ", "))")
    }
    return parts.joined(separator: " | ")
  }

  private func mountSummary(_ mount: RuntimeContainerMount) -> String {
    var suffix = mount.mode
    if let rw = mount.rw {
      suffix = suffix.isEmpty ? (rw ? "rw" : "ro") : "\(suffix),\(rw ? "rw" : "ro")"
    }
    if suffix.isEmpty {
      return "\(mount.source) -> \(mount.destination)"
    }
    return "\(mount.source) -> \(mount.destination) [\(suffix)]"
  }

  private func sortedLabels(_ labels: [String: String]) -> [(key: String, value: String)] {
    labels
      .map { (key: $0.key, value: $0.value) }
      .sorted { $0.key.localizedCaseInsensitiveCompare($1.key) == .orderedAscending }
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
    if project.kind == .registered {
      tabs.append(.branches)
      tabs.append(.sessions)
    }
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

  private var projectHeaderBackground: some ShapeStyle {
    if colorScheme == .dark {
      return AnyShapeStyle(.regularMaterial)
    }
    return AnyShapeStyle(Color.white.opacity(0.82))
  }

  private var projectHeaderShape: UnevenRoundedRectangle {
    UnevenRoundedRectangle(
      cornerRadii: .init(
        topLeading: 0,
        bottomLeading: 14,
        bottomTrailing: 14,
        topTrailing: 0
      ),
      style: .continuous
    )
  }

  private var projectHeaderStrokeColor: Color {
    colorScheme == .dark ? Color.white.opacity(0.14) : Color.black.opacity(0.08)
  }

  private var sessionQuickAccessButton: some View {
    Menu {
      if sessionEntries.count == 1, let session = sessionEntries.first {
        sessionOpenMenuItems(for: session)
      } else {
        ForEach(sessionEntries, id: \.id) { session in
          Menu(session.name) {
            sessionOpenMenuItems(for: session)
          }
        }
      }
      Divider()
      Button("Manage sessions") {
        activateTab(.sessions)
      }
    } label: {
      Label(
        sessionEntries.count == 1 ? "Open session" : "\(sessionEntries.count) sessions",
        systemImage: sessionEntries.count == 1 ? "terminal" : "rectangle.3.group.bubble.left"
      )
    }
    .buttonStyle(PressableIconButtonStyle())
  }

  private var openInProjectButton: some View {
    Menu {
      if let path = projectOpenPath {
        Button {
          openProjectInEditor(preferredEditor)
        } label: {
          Label("Open in \(preferredEditor.displayName)", systemImage: "checkmark.circle.fill")
        }

        Divider()

        ForEach(availableEditors, id: \.rawValue) { editor in
          Button {
            preferredEditorRaw = editor.rawValue
            openProjectInEditor(editor)
          } label: {
            Label(
              editor.displayName,
              systemImage: editor == preferredEditor ? "checkmark.circle.fill" : "circle"
            )
          }
        }

        Divider()

        Button("Reveal in Finder") {
          NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: path)
        }
      } else {
        Text("Project path unavailable")
      }
    } label: {
      Label("Open in", systemImage: "arrow.up.right.square")
    }
    .buttonStyle(PressableIconButtonStyle())
  }

  private var codingAgentQuickAccessButton: some View {
    Menu {
      if let path = projectOpenPath {
        Button {
          openProjectInCodingAgent(preferredCodingAgent, projectPath: path)
        } label: {
          Label(
            "Open in \(preferredCodingAgent.displayName)",
            systemImage: "checkmark.circle.fill"
          )
        }

        Divider()

        ForEach(availableCodingAgents, id: \.rawValue) { agent in
          Button {
            preferredCodingAgentRaw = agent.rawValue
            openProjectInCodingAgent(agent, projectPath: path)
          } label: {
            Label(
              agent.displayName,
              systemImage: agent == preferredCodingAgent ? "checkmark.circle.fill" : "circle"
            )
          }
        }

        Divider()

        Button("Print init prompt") {
          openTerminal(
            kind: .shell,
            command: "hack agent init --path \(shellQuote(path)) --client print",
            title: "\(project.name) init prompt"
          )
        }
      } else {
        Text("Project path unavailable")
      }
    } label: {
      Label("Agent", systemImage: "sparkles")
    }
    .buttonStyle(PressableIconButtonStyle())
  }

  @ViewBuilder
  private func sessionOpenMenuItems(for session: ProjectSessionSummary) -> some View {
    ForEach(installedExternalTerminalApps, id: \.self) { terminalApp in
      Button {
        preferredExternalTerminalRaw = terminalApp.rawValue
        legacyPreferredExternalTerminalRaw = terminalApp.rawValue
        openSession(session, terminalApp: terminalApp)
      } label: {
        Label(
          "Open in \(terminalApp.displayName)",
          systemImage: terminalApp == preferredExternalTerminal ? "checkmark.circle.fill" : "circle"
        )
      }
    }
  }

  private func headerMetricPill(_ title: String, value: String) -> some View {
    HStack(spacing: 6) {
      Text(title)
        .font(.mono(.caption2))
        .foregroundStyle(.secondary)
      Text(value)
        .font(.mono(.caption, weight: .semibold))
        .lineLimit(1)
        .truncationMode(.tail)
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 6)
    .background(
      Capsule(style: .continuous)
        .fill(colorScheme == .dark ? Color.white.opacity(0.08) : Color.black.opacity(0.03))
    )
    .overlay(
      Capsule(style: .continuous)
        .stroke(colorScheme == .dark ? Color.white.opacity(0.12) : Color.black.opacity(0.08), lineWidth: 1)
    )
  }

  private func activateTab(_ tab: ProjectTab) {
    if tab == .logs {
      openTerminal(kind: .logs)
      return
    }
    if tab == .shell {
      openTerminal(kind: .shell)
      return
    }
    model.selectedProjectTab = tab
  }

  private var bottomControlBar: some View {
    HStack(spacing: 12) {
      HStack(spacing: 6) {
        ForEach(availableTabs, id: \.self) { tab in
          Button {
            activateTab(tab)
          } label: {
            Image(systemName: tabIcon(tab))
              .font(.mono(.caption, weight: .semibold))
              .foregroundStyle(tab == effectiveTab ? Color.white : Color.secondary)
              .padding(8)
              .background(
                Circle()
                  .fill(tab == effectiveTab ? Color.accentColor : hoveredControl == tab ? Color.white.opacity(0.08) : .clear)
              )
              .accessibilityLabel(tabLabel(tab))
              .overlay(alignment: .top) {
                if hoveredControl == tab {
                  iconTooltip(tabLabel(tab))
                    .fixedSize(horizontal: true, vertical: true)
                    .offset(y: -30)
                    .transition(
                      .asymmetric(
                        insertion: .opacity.combined(with: .scale(scale: 0.92, anchor: .bottom)),
                        removal: .opacity
                      )
                    )
                }
              }
          }
          .buttonStyle(PressableCircleButtonStyle())
          .onHover { hovering in
            withAnimation(.easeOut(duration: 0.16)) {
              hoveredControl = hovering ? tab : nil
            }
          }
          .zIndex(hoveredControl == tab ? 20 : 0)
        }
      }

      Divider()
        .frame(height: 18)

      if isProjectLifecycleBusy {
        HStack(spacing: 6) {
          ProgressView()
            .controlSize(.small)
          Text(projectLifecycleLabel)
            .font(.mono(.caption2, weight: .semibold))
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(
          Capsule(style: .continuous)
            .fill(colorScheme == .dark ? Color.white.opacity(0.08) : Color.black.opacity(0.04))
        )
      } else {
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
              .overlay(alignment: .top) {
                if isStartHovered {
                  iconTooltip("Start project")
                    .fixedSize(horizontal: true, vertical: true)
                    .offset(y: -30)
                    .transition(
                      .asymmetric(
                        insertion: .opacity.combined(with: .scale(scale: 0.92, anchor: .bottom)),
                        removal: .opacity
                      )
                    )
                }
              }
          }
          .buttonStyle(PressableCircleButtonStyle())
          .contentShape(Circle())
          .onHover { hovering in
            withAnimation(.easeOut(duration: 0.16)) {
              isStartHovered = hovering
            }
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
              .overlay(alignment: .top) {
                if isStopHovered {
                  iconTooltip("Stop project")
                    .fixedSize(horizontal: true, vertical: true)
                    .offset(y: -30)
                    .transition(
                      .asymmetric(
                        insertion: .opacity.combined(with: .scale(scale: 0.92, anchor: .bottom)),
                        removal: .opacity
                      )
                    )
                }
              }
          }
          .buttonStyle(PressableCircleButtonStyle())
          .contentShape(Circle())
          .onHover { hovering in
            withAnimation(.easeOut(duration: 0.16)) {
              isStopHovered = hovering
            }
          }
          .accessibilityLabel("Stop project")
        }
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
    .animation(.easeOut(duration: 0.16), value: hoveredControl)
    .animation(.easeOut(duration: 0.16), value: isStartHovered)
    .animation(.easeOut(duration: 0.16), value: isStopHovered)
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
    case .branches:
      return "arrow.triangle.branch"
    case .sessions:
      return "rectangle.3.group.bubble.left"
    case .logs:
      return "text.alignleft"
    case .shell:
      return "terminal"
    case .tickets:
      return "ticket"
    }
  }

  private func tabLabel(_ tab: ProjectTab) -> String {
    switch tab {
    case .overview:
      return "Overview"
    case .branches:
      return "Branches"
    case .sessions:
      return "Sessions"
    case .logs:
      return "Logs"
    case .shell:
      return "Shell"
    case .tickets:
      return "Tickets"
    }
  }

  private func iconTooltip(_ title: String) -> some View {
    Text(title)
      .font(.mono(.caption2, weight: .semibold))
      .lineLimit(1)
      .fixedSize(horizontal: true, vertical: false)
      .foregroundStyle(.primary)
      .padding(.horizontal, 8)
      .padding(.vertical, 4)
      .background(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .fill(.ultraThinMaterial)
          .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
              .stroke(colorScheme == .dark ? Color.white.opacity(0.18) : Color.black.opacity(0.14), lineWidth: 1)
          )
      )
      .allowsHitTesting(false)
      .shadow(color: Color.black.opacity(colorScheme == .dark ? 0.25 : 0.12), radius: 6, y: 2)
  }

  private func breadcrumbLabel(for tab: ProjectTab) -> String {
    switch tab {
    case .overview:
      return "Dashboard"
    case .branches:
      return "Branches"
    case .sessions:
      return "Sessions"
    case .logs:
      return "Logs"
    case .shell:
      return "Shell"
    case .tickets:
      return "Tickets"
    }
  }

  private func openTerminal(
    kind: TerminalDrawerModel.Kind,
    branch: String? = nil,
    command: String? = nil,
    title: String? = nil
  ) {
    let normalizedBranch = branch?.trimmingCharacters(in: .whitespacesAndNewlines)
    let resolvedBranch = (normalizedBranch?.isEmpty == false) ? normalizedBranch : nil
    let normalizedCommand = command?.trimmingCharacters(in: .whitespacesAndNewlines)
    let resolvedCommand = (normalizedCommand?.isEmpty == false) ? normalizedCommand : nil
    let normalizedTitle = title?.trimmingCharacters(in: .whitespacesAndNewlines)
    let resolvedTitle = (normalizedTitle?.isEmpty == false) ? normalizedTitle : nil
    var userInfo: [String: String] = [
      TerminalOpenRequest.projectIdKey: project.id,
      TerminalOpenRequest.kindKey: kind.rawValue
    ]
    if let resolvedBranch {
      userInfo[TerminalOpenRequest.branchKey] = resolvedBranch
    }
    if let resolvedCommand {
      userInfo[TerminalOpenRequest.commandKey] = resolvedCommand
    }
    if let resolvedTitle {
      userInfo[TerminalOpenRequest.titleKey] = resolvedTitle
    }
    NotificationCenter.default.post(
      name: .hackTerminalOpenRequested,
      object: nil,
      userInfo: userInfo
    )
  }

  private var preferredExternalTerminal: TerminalIntegration.ExternalTerminalApp {
    if let explicit = TerminalIntegration.ExternalTerminalApp(rawValue: preferredExternalTerminalRaw) {
      return explicit
    }
    if let legacy = TerminalIntegration.ExternalTerminalApp(rawValue: legacyPreferredExternalTerminalRaw) {
      return legacy
    }
    return .terminal
  }

  private var installedExternalTerminalApps: [TerminalIntegration.ExternalTerminalApp] {
    let installed = TerminalIntegration.installedExternalTerminalApps()
    if installed.isEmpty {
      return [.terminal]
    }
    if installed.contains(preferredExternalTerminal) {
      return installed
    }
    return [preferredExternalTerminal] + installed
  }

  private var preferredEditor: EditorIntegration.EditorApp {
    if let explicit = EditorIntegration.EditorApp(rawValue: preferredEditorRaw) {
      return explicit
    }
    return .cursor
  }

  private var availableEditors: [EditorIntegration.EditorApp] {
    let installed = EditorIntegration.installedEditors()
    let fallback: [EditorIntegration.EditorApp] = [.cursor, .vscode, .zed, .neovim, .vim]
    var seen: Set<EditorIntegration.EditorApp> = []
    var ordered: [EditorIntegration.EditorApp] = []
    for editor in [preferredEditor] + installed + fallback where seen.insert(editor).inserted {
      ordered.append(editor)
    }
    return ordered
  }

  private var preferredCodingAgent: CodingAgentIntegration.AgentApp {
    if let explicit = CodingAgentIntegration.AgentApp(rawValue: preferredCodingAgentRaw) {
      return explicit
    }
    return .codex
  }

  private var availableCodingAgents: [CodingAgentIntegration.AgentApp] {
    let installed = CodingAgentIntegration.installedAgents()
    var seen: Set<CodingAgentIntegration.AgentApp> = []
    var ordered: [CodingAgentIntegration.AgentApp] = []
    for agent in [preferredCodingAgent] + installed + CodingAgentIntegration.AgentApp.allCases
      where seen.insert(agent).inserted {
      ordered.append(agent)
    }
    return ordered
  }

  private var projectOpenPath: String? {
    if let repoRoot = project.repoRoot, !repoRoot.isEmpty {
      return repoRoot
    }
    if let projectDir = project.projectDir, !projectDir.isEmpty {
      return projectDir
    }
    return nil
  }

  private func openLifecycleLogs(service: String?, title: String) {
    guard let projectPath = projectOpenPath else { return }
    var command = "hack logs --pretty --path \(shellQuote(projectPath))"
    let normalizedService = service?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if !normalizedService.isEmpty {
      command += " \(shellQuote(normalizedService))"
    }
    openTerminal(kind: .shell, command: command, title: title)
  }

  private func openProjectInEditor(_ editor: EditorIntegration.EditorApp) {
    guard let path = projectOpenPath else { return }
    EditorIntegration.openProject(
      path: path,
      editor: editor,
      terminalApp: preferredExternalTerminal
    )
  }

  private func openProjectInCodingAgent(
    _ agent: CodingAgentIntegration.AgentApp,
    projectPath: String
  ) {
    let command = CodingAgentIntegration.launchCommand(
      projectPath: projectPath,
      agent: agent,
      binaryOverridePath: preferredCodingAgentBinaryPathRaw
    )
    openTerminal(
      kind: .shell,
      command: command,
      title: "\(agent.displayName) - \(project.name)"
    )
  }

  private func attachCommand(for session: ProjectSessionSummary) -> String {
    switch session.backend {
    case .tmux:
      return "env -u TMUX tmux attach -d -t \(shellQuote(session.name))"
    case .zellij:
      return "zellij attach \(shellQuote(session.name))"
    }
  }

  private func openSession(
    _ session: ProjectSessionSummary,
    terminalApp: TerminalIntegration.ExternalTerminalApp
  ) {
    if terminalApp == .hackDesktop {
      openTerminal(
        kind: .shell,
        command: attachCommand(for: session),
        title: "\(session.name) (attached)"
      )
      return
    }
    openSessionExternally(session, terminalApp: terminalApp)
  }

  private func openSessionExternally(
    _ session: ProjectSessionSummary,
    terminalApp: TerminalIntegration.ExternalTerminalApp
  ) {
    TerminalIntegration.openExternalTerminalWithCommand(
      attachCommand(for: session),
      app: terminalApp
    )
  }

  private func shellQuote(_ value: String) -> String {
    if value.isEmpty {
      return "''"
    }
    return "'\(value.replacingOccurrences(of: "'", with: "'\"'\"'"))'"
  }

}
