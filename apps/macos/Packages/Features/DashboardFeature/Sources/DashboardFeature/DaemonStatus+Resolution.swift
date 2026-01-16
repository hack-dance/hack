import HackDesktopModels

extension DaemonStatus {
  var resolvedLabel: DaemonStatusLabel {
    if let status {
      return status
    }
    if apiOk == true {
      return .running
    }
    if processRunning == true || running {
      return .starting
    }
    if pid != nil || socketExists == true {
      return .stale
    }
    return .stopped
  }
}

extension Optional where Wrapped == DaemonStatus {
  var resolvedLabel: DaemonStatusLabel? {
    guard let status = self else { return nil }
    return status.resolvedLabel
  }
}
