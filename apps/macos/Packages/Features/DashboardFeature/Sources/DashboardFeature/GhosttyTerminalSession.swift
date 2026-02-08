import AppKit
import Foundation
import Observation

import GhosttyTerminal
import HackCLIService
import HackDesktopModels

@MainActor
@Observable
final class GhosttyTerminalSession {
  struct TerminalCommand {
    let executableURL: URL
    let arguments: [String]
    let environment: [String: String]
    let workingDirectory: URL?
  }

  enum Mode {
    case logs(path: String)
    case shell(workingDirectory: URL)
    case sessionAttach(sessionName: String, workingDirectory: URL?)
  }

  let project: ProjectSummary
  let mode: Mode

  var snapshot: GhosttyRenderSnapshot? = nil
  var renderVersion: Int = 0
  var statusMessage: String = "Preparing terminal…"
  var isAvailable: Bool = false

  private var terminal: GhosttyTerminal?
  private var pty: PtyProcess?
  private var refreshTask: Task<Void, Never>?
  private var hasPendingRefresh = false
  private var isStarted = false
  private var hasReceivedInitialSize = false
  private var pendingStart = false
  private var lastCols = 120
  private var lastRows = 32
  private var pendingWrites: [Data] = []
  private var initialCommand: String?

  var allowsInput: Bool {
    switch mode {
    case .shell:
      return true
    case .sessionAttach:
      return true
    case .logs:
      return false
    }
  }

  init(project: ProjectSummary) {
    self.project = project
    if let path = project.projectDir ?? project.repoRoot {
      self.mode = .logs(path: path)
    } else {
      self.mode = .logs(path: "")
    }
    configureTerminal()
  }

  init(project: ProjectSummary, mode: Mode) {
    self.project = project
    self.mode = mode
    configureTerminal()
  }

  init(project: ProjectSummary, mode: Mode, initialCommand: String?) {
    self.project = project
    self.mode = mode
    self.initialCommand = initialCommand
    if let initialCommand, !initialCommand.isEmpty {
      pendingWrites.append(Data((initialCommand + "\n").utf8))
    }
    configureTerminal()
  }

  private func configureTerminal() {
    if let terminal = GhosttyVTRuntime.shared.makeTerminal(cols: lastCols, rows: lastRows) {
      self.terminal = terminal
      applyTheme()
      self.isAvailable = true
    } else {
      self.isAvailable = false
      self.statusMessage = GhosttyVTRuntime.shared.loadMessage ?? "Ghostty VT unavailable"
    }
  }

  func start() {
    guard !isStarted else { return }

    // Wait for the view to report its actual size before launching
    // This ensures the process gets the correct terminal dimensions
    guard hasReceivedInitialSize else {
      pendingStart = true
      return
    }

    isStarted = true
    guard isAvailable else { return }

    var environment = buildEnvironment()
    // Ensure terminal size is in environment for programs that check
    environment["COLUMNS"] = String(lastCols)
    environment["LINES"] = String(lastRows)
    let command = resolveCommand(in: environment)

    do {
      let pty = try PtyProcess(
        executableURL: command.executableURL,
        arguments: command.arguments,
        environment: command.environment,
        cols: lastCols,
        rows: lastRows,
        workingDirectory: command.workingDirectory
      )
      pty.process.terminationHandler = { [weak self] proc in
        self?.handleTermination(proc.terminationStatus)
      }
      pty.masterFileHandle.readabilityHandler = { [weak self] handle in
        self?.handleReadableData(handle)
      }
      self.pty = pty
      switch mode {
      case .shell:
        statusMessage = "Shell ready"
      case .logs:
        statusMessage = "Streaming logs…"
      case let .sessionAttach(sessionName, _):
        statusMessage = "Attached: \(sessionName)"
      }
      flushPendingWrites()
      startRefreshLoop()
    } catch {
      statusMessage = "Failed to start session: \(error.localizedDescription)"
    }
  }

  func stop() {
    refreshTask?.cancel()
    refreshTask = nil
    pty?.terminate()
    pty = nil
    isStarted = false
  }

  func resize(cols: Int, rows: Int) {
    lastCols = cols
    lastRows = rows
    terminal?.resize(cols: cols, rows: rows)
    pty?.resize(cols: cols, rows: rows)
    hasPendingRefresh = true

    // After receiving first size from view, start the process if pending
    if !hasReceivedInitialSize {
      hasReceivedInitialSize = true
      if pendingStart {
        pendingStart = false
        start()
      }
    }
  }

  func send(_ data: Data) {
    guard allowsInput else { return }
    if let pty {
      pty.send(data)
    } else {
      pendingWrites.append(data)
    }
  }

  func sendControl(_ data: Data) {
    guard !data.isEmpty else { return }
    let isControl = data.allSatisfy { $0 < 0x20 || $0 == 0x7F }
    guard isControl else { return }
    if data == Data([0x03]) {
      pty?.interrupt()
    }
    if let pty {
      pty.send(data)
    } else {
      pendingWrites.append(data)
    }
  }

  private func flushPendingWrites() {
    guard allowsInput else { return }
    guard let pty else { return }
    guard !pendingWrites.isEmpty else { return }
    for write in pendingWrites {
      pty.send(write)
    }
    pendingWrites.removeAll(keepingCapacity: true)
  }

  nonisolated private func handleTermination(_ status: Int32) {
    Task { @MainActor [weak self] in
      self?.statusMessage = "Session exited (\(status))"
    }
  }

  nonisolated private func handleReadableData(_ handle: FileHandle) {
    let data = handle.availableData
    guard !data.isEmpty else { return }
    Task { @MainActor [weak self] in
      self?.feed(data)
    }
  }

  private func feed(_ data: Data) {
    terminal?.feed(data)
    hasPendingRefresh = true
  }

  func scrollViewport(deltaRows: Int) {
    terminal?.scrollViewport(deltaRows: deltaRows)
    hasPendingRefresh = true
  }

  func scrollViewportTop() {
    terminal?.scrollViewportTop()
    hasPendingRefresh = true
  }

  func scrollViewportBottom() {
    terminal?.scrollViewportBottom()
    hasPendingRefresh = true
  }

  private func startRefreshLoop() {
    refreshTask?.cancel()
    refreshTask = Task { [weak self] in
      while let self, !Task.isCancelled {
        try? await Task.sleep(nanoseconds: 16_666_667)
        guard self.hasPendingRefresh else { continue }
        self.hasPendingRefresh = false
        guard let terminal = self.terminal else { continue }
        guard let snapshot = terminal.renderSnapshot() else { continue }
        self.snapshot = snapshot
        self.renderVersion &+= 1
      }
    }
  }

  private func buildEnvironment() -> [String: String] {
    var environment = HackCLILocator.buildEnvironment()
    environment["TERM"] = "xterm-256color"
    environment["TERM_PROGRAM"] = "HackDesktop"
    environment["TERM_PROGRAM_VERSION"] = "1.0.0"
    if environment["COLORTERM"] == nil {
      environment["COLORTERM"] = "truecolor"
    }
    if environment["LANG"] == nil {
      environment["LANG"] = "en_US.UTF-8"
    }
    if environment["LC_ALL"] == nil {
      environment["LC_ALL"] = "en_US.UTF-8"
    }
    return environment
  }

  private func applyTheme() {
    guard let terminal else { return }

    // Enable newline mode (LNM) so LF acts as CR+LF
    // This is needed for proper log output formatting
    terminal.feed(Data("\u{1B}[20h".utf8))

    let foreground: String = "#E6E6E6"
    let background: String = "#0B0C0F"
    let cursor: String = "#F5C2E7"

    // Build palette from a single literal string to keep previews' design-time
    // instrumentation simple and avoid type-checker blowups.
    let palette: [String] = """
#0B0C0F #E06C75 #98C379 #E5C07B
#61AFEF #C678DD #56B6C2 #C8CCD4
#5C6370 #E06C75 #98C379 #E5C07B
#61AFEF #C678DD #56B6C2 #FFFFFF
"""
      .split(whereSeparator: \.isWhitespace)
      .map(String.init)

    var sequences: [String] = [
      osc("10", foreground),
      osc("11", background),
      osc("12", cursor)
    ]

    for (index, color) in palette.enumerated() {
      sequences.append(osc("4", "\(index);\(color)"))
    }

    let payload: String = sequences.joined()
    terminal.feed(Data(payload.utf8))
  }

  private func osc(_ ps: String, _ pt: String) -> String {
    "\u{1B}]\(ps);\(pt)\u{07}"
  }

  private func resolveCommand(in environment: [String: String]) -> TerminalCommand {
    switch mode {
    case let .logs(path):
      if path.isEmpty {
        return TerminalCommand(
          executableURL: URL(fileURLWithPath: "/usr/bin/env"),
          arguments: ["echo", "Missing project path"],
          environment: environment,
          workingDirectory: nil
        )
      }

      if let hackPath = HackCLILocator.resolveHackExecutable(in: environment) {
        return TerminalCommand(
          executableURL: URL(fileURLWithPath: hackPath),
          arguments: ["logs", "--pretty", "--path", path],
          environment: environment,
          workingDirectory: URL(fileURLWithPath: path)
        )
      }

      return TerminalCommand(
        executableURL: URL(fileURLWithPath: "/usr/bin/env"),
        arguments: ["hack", "logs", "--pretty", "--path", path],
        environment: environment,
        workingDirectory: URL(fileURLWithPath: path)
      )
    case let .shell(workingDirectory):
      let zshPath = "/bin/zsh"
      if FileManager.default.isExecutableFile(atPath: zshPath) {
        return TerminalCommand(
          executableURL: URL(fileURLWithPath: zshPath),
          arguments: ["-l"],
          environment: environment,
          workingDirectory: workingDirectory
        )
      }

      return TerminalCommand(
        executableURL: URL(fileURLWithPath: "/usr/bin/env"),
        arguments: ["zsh", "-l"],
        environment: environment,
        workingDirectory: workingDirectory
      )
    case let .sessionAttach(sessionName, workingDirectory):
      let trimmed = sessionName.trimmingCharacters(in: .whitespacesAndNewlines)
      if trimmed.isEmpty {
        return TerminalCommand(
          executableURL: URL(fileURLWithPath: "/usr/bin/env"),
          arguments: ["echo", "Missing session name"],
          environment: environment,
          workingDirectory: workingDirectory
        )
      }

      if let hackPath = HackCLILocator.resolveHackExecutable(in: environment) {
        return TerminalCommand(
          executableURL: URL(fileURLWithPath: hackPath),
          arguments: ["session", "attach", trimmed],
          environment: environment,
          workingDirectory: workingDirectory
        )
      }

      return TerminalCommand(
        executableURL: URL(fileURLWithPath: "/usr/bin/env"),
        arguments: ["hack", "session", "attach", trimmed],
        environment: environment,
        workingDirectory: workingDirectory
      )
    }
  }

}
