import Foundation

import HackDesktopModels

public enum HackCLIError: LocalizedError, Equatable {
  case commandFailed(exitCode: Int, stderr: String)
  case emptyOutput
  case invalidJson

  public var errorDescription: String? {
    switch self {
    case let .commandFailed(exitCode, stderr):
      return "hack exited with code \(exitCode): \(stderr)"
    case .emptyOutput:
      return "hack returned empty output"
    case .invalidJson:
      return "hack returned invalid JSON"
    }
  }
}

public actor HackCLIClient {
  public init() {}

  public func fetchProjects(includeGlobal: Bool) async throws -> ProjectListResponse {
    var args = ["projects", "--json"]
    if includeGlobal {
      args.append("--include-global")
    }

    let result = try await run(args)
    return try decode(ProjectListResponse.self, from: result.stdout)
  }

  public func daemonStatus() async throws -> DaemonStatus {
    let result = try await run(["daemon", "status", "--json"], allowNonZeroExit: true)
    return try decode(DaemonStatus.self, from: result.stdout)
  }

  public func fetchGlobalStatus() async throws -> GlobalStatusResponse {
    let result = try await run(["global", "status", "--json"], allowNonZeroExit: true)
    return try decode(GlobalStatusResponse.self, from: result.stdout)
  }

  public func startDaemon() async throws {
    _ = try await run(["daemon", "start"])
  }

  public func stopDaemon() async throws {
    _ = try await run(["daemon", "stop"])
  }

  public func restartDaemon() async throws {
    _ = try await run(["daemon", "restart"])
  }

  public func clearDaemon() async throws {
    _ = try await run(["daemon", "clear"])
  }

  public func startProject(path: String) async throws {
    _ = try await run(["up", "--path", path, "--detach"])
  }

  public func stopProject(path: String) async throws {
    _ = try await run(["down", "--path", path])
  }

  private func decode<T: Decodable>(_ type: T.Type, from text: String) throws -> T {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty {
      throw HackCLIError.emptyOutput
    }

    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase

    guard let data = trimmed.data(using: .utf8) else {
      throw HackCLIError.invalidJson
    }
    do {
      return try decoder.decode(T.self, from: data)
    } catch {
      throw HackCLIError.invalidJson
    }
  }

  private func run(
    _ args: [String],
    allowNonZeroExit: Bool = false
  ) async throws -> CLIResult {
    let process = Process()
    let environment = HackCLILocator.buildEnvironment()
    process.environment = environment

    if let hackPath = HackCLILocator.resolveHackExecutable(in: environment) {
      process.executableURL = URL(fileURLWithPath: hackPath)
      process.arguments = args
    } else {
      process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
      process.arguments = ["hack"] + args
    }

    let stdoutPipe = Pipe()
    let stderrPipe = Pipe()
    process.standardOutput = stdoutPipe
    process.standardError = stderrPipe

    let exitCode = await withCheckedContinuation { continuation in
      process.terminationHandler = { proc in
        continuation.resume(returning: Int(proc.terminationStatus))
      }

      do {
        try process.run()
      } catch {
        stdoutPipe.fileHandleForReading.closeFile()
        stderrPipe.fileHandleForReading.closeFile()
        continuation.resume(returning: 127)
      }
    }

    async let stdoutData = stdoutPipe.fileHandleForReading.readToEnd()
    async let stderrData = stderrPipe.fileHandleForReading.readToEnd()

    let stdoutBytes: Data?
    let stderrBytes: Data?

    do {
      stdoutBytes = try await stdoutData
    } catch {
      stdoutBytes = nil
    }

    do {
      stderrBytes = try await stderrData
    } catch {
      stderrBytes = nil
    }

    let stdout = String(decoding: stdoutBytes ?? Data(), as: UTF8.self)
    let stderr = String(decoding: stderrBytes ?? Data(), as: UTF8.self)

    if exitCode != 0 && !allowNonZeroExit {
      throw HackCLIError.commandFailed(exitCode: exitCode, stderr: stderr.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    return CLIResult(stdout: stdout, stderr: stderr, exitCode: exitCode)
  }

}

private struct CLIResult {
  let stdout: String
  let stderr: String
  let exitCode: Int
}
