import Darwin
import Foundation

public enum PtyProcessError: LocalizedError {
  case openFailed(Int32)
  case launchFailed(Error)

  public var errorDescription: String? {
    switch self {
    case let .openFailed(code):
      return "openpty failed (\(code))"
    case let .launchFailed(error):
      return "Failed to launch process: \(error.localizedDescription)"
    }
  }
}

public final class PtyProcess {
  public let process: Process
  public let masterFileHandle: FileHandle

  private let slaveHandle: FileHandle
  private let masterFd: Int32
  private var isClosed = false

  public init(
    executableURL: URL,
    arguments: [String],
    environment: [String: String],
    cols: Int,
    rows: Int,
    workingDirectory: URL? = nil
  ) throws {
    var master: Int32 = 0
    var slave: Int32 = 0
    var term = termios()
    _ = tcgetattr(STDIN_FILENO, &term)
    var size = winsize()
    size.ws_col = UInt16(clamping: cols)
    size.ws_row = UInt16(clamping: rows)

    if openpty(&master, &slave, nil, &term, &size) != 0 {
      throw PtyProcessError.openFailed(errno)
    }

    let masterHandle = FileHandle(fileDescriptor: master, closeOnDealloc: false)
    let slaveHandle = FileHandle(fileDescriptor: slave, closeOnDealloc: false)

    let process = Process()
    process.executableURL = executableURL
    process.arguments = arguments
    process.environment = environment
    process.currentDirectoryURL = workingDirectory
    process.standardInput = slaveHandle
    process.standardOutput = slaveHandle
    process.standardError = slaveHandle

    do {
      try process.run()
    } catch {
      masterHandle.closeFile()
      slaveHandle.closeFile()
      throw PtyProcessError.launchFailed(error)
    }

    self.process = process
    self.masterFileHandle = masterHandle
    self.slaveHandle = slaveHandle
    self.masterFd = master
  }

  deinit {
    closeHandles()
  }

  public func resize(cols: Int, rows: Int) {
    guard !isClosed else { return }
    var size = winsize()
    size.ws_col = UInt16(clamping: cols)
    size.ws_row = UInt16(clamping: rows)
    _ = ioctl(masterFd, TIOCSWINSZ, &size)
  }

  public func send(_ data: Data) {
    guard !isClosed else { return }
    masterFileHandle.write(data)
  }

  public func interrupt() {
    guard !isClosed else { return }
    if process.isRunning {
      let pid = process.processIdentifier
      _ = killpg(pid, SIGINT)
      _ = kill(pid, SIGINT)
    }
  }

  public func terminate() {
    guard !isClosed else { return }
    process.terminate()
    closeHandles()
  }

  private func closeHandles() {
    guard !isClosed else { return }
    isClosed = true
    masterFileHandle.readabilityHandler = nil
    masterFileHandle.closeFile()
    slaveHandle.closeFile()
  }
}
