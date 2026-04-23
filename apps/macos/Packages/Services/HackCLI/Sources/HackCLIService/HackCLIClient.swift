import Foundation

import HackDesktopModels

public enum HackCLIError: LocalizedError, Equatable {
  case commandFailed(exitCode: Int, stderr: String)
  case emptyOutput
  case invalidJson
  case network(String)

  public var errorDescription: String? {
    switch self {
    case let .commandFailed(exitCode, stderr):
      return "hack exited with code \(exitCode): \(stderr)"
    case .emptyOutput:
      return "hack returned empty output"
    case .invalidJson:
      return "hack returned invalid JSON"
    case let .network(message):
      return message
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
    return try decodeLenient(ProjectListResponse.self, from: result.stdout)
  }

  public func daemonStatus() async throws -> DaemonStatus {
    let result = try await run(["daemon", "status", "--json"], allowNonZeroExit: true)
    return try decodeJsonOrThrow(DaemonStatus.self, result: result)
  }

  public func fetchGlobalStatus() async throws -> GlobalStatusResponse {
    let result = try await run(["global", "status", "--json"], allowNonZeroExit: true)
    return try decodeJsonOrThrow(GlobalStatusResponse.self, result: result)
  }

  public func globalUp() async throws {
    _ = try await run(["global", "up"])
  }

  public func globalDown() async throws {
    _ = try await run(["global", "down"])
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

  public func startProject(path: String, target: String = "auto") async throws {
    _ = try await run(["up", "--path", path, "--detach", "--target", target])
  }

  public func stopProject(path: String, target: String = "auto") async throws {
    _ = try await run(["down", "--path", path, "--target", target])
  }

  public func startBranch(path: String, branch: String) async throws {
    _ = try await run(["up", "--path", path, "--branch", branch, "--detach"])
  }

  public func stopBranch(path: String, branch: String) async throws {
    _ = try await run(["down", "--path", path, "--branch", branch])
  }

  public func addBranch(path: String, name: String, note: String?) async throws {
    var args = ["branch", "add", name, "--path", path]
    if let note, !note.isEmpty {
      args.append(contentsOf: ["--note", note])
    }
    _ = try await run(args)
  }

  public func removeBranch(path: String, name: String) async throws {
    _ = try await run(["branch", "remove", name, "--path", path])
  }

  public func stopSession(name: String) async throws {
    _ = try await run(["session", "stop", name])
  }

  public func startSession(projectName: String, detached: Bool = true) async throws {
    var args = ["session", "start", projectName]
    if detached {
      args.append("--detach")
    }
    _ = try await run(args)
  }

  public func setGlobalConfig(key: String, value: String) async throws {
    _ = try await run(["config", "set", key, value, "--global"])
  }

  public func getGlobalConfigValue(key: String) async throws -> String? {
    let result = try await run(
      ["config", "get", key, "--global"],
      allowNonZeroExit: true
    )
    guard result.exitCode == 0 else {
      return nil
    }
    let value = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
    return value.isEmpty ? nil : value
  }

  public func setProjectConfig(
    key: String,
    value: String,
    projectPath: String
  ) async throws {
    _ = try await run(["config", "set", key, value], cwd: projectPath)
  }

  public func getProjectConfigValue(
    key: String,
    projectPath: String
  ) async throws -> String? {
    let result = try await run(
      ["config", "get", key],
      allowNonZeroExit: true,
      cwd: projectPath
    )
    guard result.exitCode == 0 else {
      return nil
    }
    let value = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
    return value.isEmpty ? nil : value
  }

  public func startCloudflareTunnel() async throws {
    _ = try await run(["x", "cloudflare", "tunnel-start"])
  }

  public func stopCloudflareTunnel() async throws {
    _ = try await run(["x", "cloudflare", "tunnel-stop"])
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

  private func decodeLenient<T: Decodable>(_ type: T.Type, from text: String) throws -> T {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty {
      throw HackCLIError.emptyOutput
    }

    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase

    if let data = trimmed.data(using: .utf8), let decoded = try? decoder.decode(T.self, from: data) {
      return decoded
    }

    for snippet in extractJsonSnippets(from: trimmed) {
      if let data = snippet.data(using: .utf8),
         let decoded = try? decoder.decode(T.self, from: data) {
        return decoded
      }
    }

    throw HackCLIError.invalidJson
  }

  private func extractJsonSnippets(from text: String) -> [String] {
    var snippets: [String] = []
    var seen: Set<String> = []
    for index in text.indices {
      let char = text[index]
      guard char == "{" || char == "[" else {
        continue
      }
      guard let snippet = extractBalancedJson(from: text, startAt: index) else {
        continue
      }
      if seen.insert(snippet).inserted {
        snippets.append(snippet)
      }
    }
    return snippets
  }

  private func extractBalancedJson(from text: String, startAt startIndex: String.Index) -> String? {
    let startChar = text[startIndex]
    guard startChar == "{" || startChar == "[" else {
      return nil
    }

    var stack: [Character] = [startChar == "{" ? "}" : "]"]
    var insideString = false
    var escaped = false
    var index = text.index(after: startIndex)

    while index < text.endIndex {
      let char = text[index]

      if insideString {
        if escaped {
          escaped = false
        } else if char == "\\" {
          escaped = true
        } else if char == "\"" {
          insideString = false
        }
      } else {
        switch char {
        case "\"":
          insideString = true
        case "{":
          stack.append("}")
        case "[":
          stack.append("]")
        case "}", "]":
          guard let expected = stack.last, char == expected else {
            return nil
          }
          _ = stack.removeLast()
          if stack.isEmpty {
            return String(text[startIndex...index])
          }
        default:
          break
        }
      }

      index = text.index(after: index)
    }

    return nil
  }

  private func run(
    _ args: [String],
    allowNonZeroExit: Bool = false,
    cwd: String? = nil,
    stdin: String? = nil
  ) async throws -> CLIResult {
    try Task.checkCancellation()

    let process = Process()
    let environment = HackCLILocator.buildEnvironment()
    process.environment = environment
    if let cwd, !cwd.isEmpty {
      process.currentDirectoryURL = URL(fileURLWithPath: cwd)
    }

    if let hackPath = HackCLILocator.resolveHackExecutable(in: environment) {
      process.executableURL = URL(fileURLWithPath: hackPath)
      process.arguments = args
    } else {
      process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
      process.arguments = ["hack"] + args
    }

    let stdoutPipe = Pipe()
    let stderrPipe = Pipe()
    let stdinPipe = stdin == nil ? nil : Pipe()
    process.standardOutput = stdoutPipe
    process.standardError = stderrPipe
    if let stdinPipe {
      process.standardInput = stdinPipe
    }

    return try await withTaskCancellationHandler(operation: {
      do {
        try process.run()
      } catch {
        stdoutPipe.fileHandleForReading.closeFile()
        stderrPipe.fileHandleForReading.closeFile()
        stdinPipe?.fileHandleForReading.closeFile()
        stdinPipe?.fileHandleForWriting.closeFile()
        throw HackCLIError.commandFailed(exitCode: 127, stderr: error.localizedDescription)
      }

      if let stdin, let stdinPipe {
        if let stdinData = stdin.data(using: .utf8) {
          stdinPipe.fileHandleForWriting.write(stdinData)
        }
        stdinPipe.fileHandleForWriting.closeFile()
      }

      async let stdoutData = stdoutPipe.fileHandleForReading.readToEnd()
      async let stderrData = stderrPipe.fileHandleForReading.readToEnd()
      let exitCode = await Task.detached(priority: nil) {
        process.waitUntilExit()
        return Int(process.terminationStatus)
      }.value

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

      try Task.checkCancellation()

      let stdout = String(decoding: stdoutBytes ?? Data(), as: UTF8.self)
      let stderr = String(decoding: stderrBytes ?? Data(), as: UTF8.self)

      if exitCode != 0 && !allowNonZeroExit {
        throw HackCLIError.commandFailed(
          exitCode: exitCode,
          stderr: stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        )
      }

      return CLIResult(stdout: stdout, stderr: stderr, exitCode: exitCode)
    }, onCancel: {
      if process.isRunning {
        process.terminate()
      }
      stdoutPipe.fileHandleForReading.closeFile()
      stderrPipe.fileHandleForReading.closeFile()
      stdinPipe?.fileHandleForReading.closeFile()
      stdinPipe?.fileHandleForWriting.closeFile()
    })
  }

  private func decodeJsonOrThrow<T: Decodable>(_ type: T.Type, result: CLIResult) throws -> T {
    let trimmedStdout = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
    let trimmedStderr = result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)

    // When callers allow non-zero exit, we still want a useful error (stderr) instead of "empty output".
    if trimmedStdout.isEmpty {
      throw HackCLIError.commandFailed(exitCode: result.exitCode, stderr: trimmedStderr)
    }

    do {
      return try decode(type, from: trimmedStdout)
    } catch {
      if let decoded = try? decodeLenient(type, from: trimmedStdout) {
        return decoded
      }
      // If hack printed logs or other output, surface stderr as the actionable hint.
      if !trimmedStderr.isEmpty {
        throw HackCLIError.commandFailed(exitCode: result.exitCode, stderr: trimmedStderr)
      }
      if result.exitCode != 0 {
        throw HackCLIError.commandFailed(
          exitCode: result.exitCode,
          stderr: "command failed without JSON payload"
        )
      }
      throw error
    }
  }

  private func tryDecodeLenient<T: Decodable>(
    _ type: T.Type,
    from text: String
  ) -> T? {
    try? decodeLenient(type, from: text)
  }

}

private struct CLIResult {
  let stdout: String
  let stderr: String
  let exitCode: Int
}
