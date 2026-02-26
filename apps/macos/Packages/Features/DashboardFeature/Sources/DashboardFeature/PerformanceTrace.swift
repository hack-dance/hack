import Foundation
import OSLog

/// Small debug-focused timing helper for spotting slow SwiftUI derivation paths.
///
/// This keeps instrumentation centralized so feature views can wrap expensive
/// transforms (sorting, filtering, data shaping) without ad hoc logging.
enum PerformanceTrace {
  private static let logger = Logger(subsystem: "dance.hack.desktop", category: "performance")
  private static let signposter = OSSignposter(logger: logger)

  static func measure<T>(
    _ name: StaticString,
    thresholdMs: Double = 8,
    _ block: () -> T
  ) -> T {
    #if DEBUG
      let signpostState = signposter.beginInterval(name)
      let start = CFAbsoluteTimeGetCurrent()
      let result = block()
      let elapsedMs = (CFAbsoluteTimeGetCurrent() - start) * 1_000
      signposter.endInterval(name, signpostState)
      if elapsedMs >= thresholdMs {
        logger.debug("Slow path \(name, privacy: .public): \(elapsedMs, format: .fixed(precision: 2)) ms")
      }
      return result
    #else
      return block()
    #endif
  }
}
