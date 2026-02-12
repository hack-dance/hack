import Foundation
import Observation

import HackDesktopModels

@MainActor
@Observable
final class TerminalDrawerModel {
  enum Kind: String {
    case logs
    case shell
  }

  struct TabKey: Hashable {
    let projectId: String
    let kind: Kind
    let branch: String?
  }

  struct Tab: Identifiable, Equatable {
    let id: UUID
    let key: TabKey?
    var title: String
    let session: GhosttyTerminalSession

    static func == (lhs: Tab, rhs: Tab) -> Bool {
      lhs.id == rhs.id
    }
  }

  let globalShellProject: ProjectSummary

  var tabs: [Tab]
  var selectedTabId: Tab.ID

  private var isActive: Bool = false

  init(globalShellProject: ProjectSummary) {
    self.globalShellProject = globalShellProject

    let session = Self.makeShellSession(project: globalShellProject, initialCommand: nil)
    let tab = Tab(
      id: UUID(),
      key: TabKey(projectId: globalShellProject.id, kind: .shell, branch: nil),
      title: Self.makeTabTitle(project: globalShellProject, kind: .shell),
      session: session
    )

    self.tabs = [tab]
    self.selectedTabId = tab.id
  }

  func setActive(_ active: Bool) {
    isActive = active
  }

  func startAll() {
    for tab in tabs {
      tab.session.start()
    }
  }

  func stopAll() {
    for tab in tabs {
      tab.session.stop()
    }
  }

  func selectedSession() -> GhosttyTerminalSession? {
    tabs.first(where: { $0.id == selectedTabId })?.session
  }

  func openOrSelect(
    project: ProjectSummary,
    kind: Kind,
    branch: String? = nil,
    initialCommand: String? = nil,
    titleOverride: String? = nil
  ) {
    let normalizedBranch = branch?.trimmingCharacters(in: .whitespacesAndNewlines)
    let tabBranch = (normalizedBranch?.isEmpty == false) ? normalizedBranch : nil
    let normalizedCommand = initialCommand?.trimmingCharacters(in: .whitespacesAndNewlines)
    let resolvedCommand = (normalizedCommand?.isEmpty == false) ? normalizedCommand : nil

    if kind == .shell, let resolvedCommand {
      let session = Self.makeShellSession(project: project, initialCommand: resolvedCommand)
      let title = titleOverride ?? "\(Self.tabBaseTitle(for: project)) command"
      let tab = Tab(id: UUID(), key: nil, title: title, session: session)
      tabs.append(tab)
      selectedTabId = tab.id
      if isActive {
        session.start()
      }
      return
    }

    let key = TabKey(projectId: project.id, kind: kind, branch: tabBranch)
    if let existing = tabs.first(where: { $0.key == key }) {
      selectedTabId = existing.id
      return
    }

    let session: GhosttyTerminalSession
    switch kind {
    case .logs:
      session = GhosttyTerminalSession(project: project, branch: tabBranch)
    case .shell:
      session = Self.makeShellSession(project: project, initialCommand: nil)
    }

    let tab = Tab(
      id: UUID(),
      key: key,
      title: Self.makeTabTitle(project: project, kind: kind, branch: tabBranch),
      session: session
    )
    tabs.append(tab)
    selectedTabId = tab.id

    if isActive {
      session.start()
    }
  }

  func addShellTab() {
    guard let baseProject = selectedSession()?.project else {
      openOrSelect(project: globalShellProject, kind: .shell)
      return
    }

    let session = Self.makeShellSession(project: baseProject, initialCommand: nil)
    let ordinal = nextShellOrdinal(for: baseProject)
    let title = Self.makeShellTitle(project: baseProject, ordinal: ordinal)
    let tab = Tab(id: UUID(), key: nil, title: title, session: session)
    tabs.append(tab)
    selectedTabId = tab.id
    if isActive {
      session.start()
    }
  }

  func closeTab(id: Tab.ID) {
    guard let index = tabs.firstIndex(where: { $0.id == id }) else { return }
    let closing = tabs[index]
    if isActive {
      closing.session.stop()
    }
    tabs.remove(at: index)

    if selectedTabId == id {
      selectedTabId = tabs.last?.id ?? selectedTabId
    }
  }

  private func nextShellOrdinal(for project: ProjectSummary) -> Int {
    let base = Self.tabBaseTitle(for: project)
    var maxOrdinal = 0
    for tab in tabs {
      let (tabBase, tabOrdinal) = Self.parseTabTitle(tab.title)
      if tabBase == base {
        maxOrdinal = max(maxOrdinal, tabOrdinal)
      }
    }
    return maxOrdinal + 1
  }

  private static func makeShellSession(project: ProjectSummary, initialCommand: String?) -> GhosttyTerminalSession {
    let workingDirectory = project.repoRoot ?? project.projectDir ?? FileManager.default.homeDirectoryForCurrentUser.path
    return GhosttyTerminalSession(
      project: project,
      mode: .shell(workingDirectory: URL(fileURLWithPath: workingDirectory)),
      initialCommand: initialCommand
    )
  }

  private static func makeTabTitle(
    project: ProjectSummary,
    kind: Kind,
    branch: String? = nil
  ) -> String {
    let branchSuffix = {
      guard let branch, !branch.isEmpty else { return "" }
      return " [\(branch)]"
    }()

    switch kind {
    case .shell:
      return makeShellTitle(project: project, ordinal: 1)
    case .logs:
      let base = tabBaseTitle(for: project)
      return "\(base)\(branchSuffix) logs"
    }
  }

  private static func makeShellTitle(project: ProjectSummary, ordinal: Int) -> String {
    let base = tabBaseTitle(for: project)
    if ordinal <= 1 {
      return base
    }
    return "\(base) \(ordinal)"
  }

  private static func tabBaseTitle(for project: ProjectSummary) -> String {
    if project.projectId == "global-shell" {
      return "~"
    }

    let trimmedName = project.name.trimmingCharacters(in: .whitespacesAndNewlines)
    if !trimmedName.isEmpty {
      return trimmedName
    }

    if let repoRoot = project.repoRoot, !repoRoot.isEmpty {
      return URL(fileURLWithPath: repoRoot).lastPathComponent
    }

    if let projectDir = project.projectDir, !projectDir.isEmpty {
      return URL(fileURLWithPath: projectDir).lastPathComponent
    }

    return "Shell"
  }

  /// Best-effort: parse `"<base>"` or `"<base> <n>"` into (base, ordinal).
  private static func parseTabTitle(_ title: String) -> (base: String, ordinal: Int) {
    let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let lastSpace = trimmed.lastIndex(of: " ") else {
      return (trimmed, 1)
    }

    let base = String(trimmed[..<lastSpace])
    let suffix = trimmed[trimmed.index(after: lastSpace)...]
    if let ordinal = Int(suffix), ordinal >= 2, !base.isEmpty {
      return (base, ordinal)
    }

    return (trimmed, 1)
  }
}
