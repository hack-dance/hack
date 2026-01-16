import HackDesktopModels

extension ProjectSummary {
  var featureList: [String] {
    features ?? []
  }

  var featureLabel: String? {
    let names = featureList.map { displayFeatureName($0) }
    guard !names.isEmpty else { return nil }
    if names.count == 1 { return names[0] }
    return "Extensions"
  }

  var featureSummary: String? {
    let names = featureList.map { displayFeatureName($0) }
    guard !names.isEmpty else { return nil }
    return names.joined(separator: " · ")
  }

  var isRuntimeConfigured: Bool {
    if let runtimeConfigured {
      return runtimeConfigured
    }
    return definedServices != nil
  }

  var isExtensionOnly: Bool {
    !isRuntimeConfigured && !featureList.isEmpty
  }

  var runtimeStatusLabel: String {
    if let runtimeStatus {
      return displayRuntimeStatus(runtimeStatus)
    }
    return status.rawValue.replacingOccurrences(of: "_", with: " ")
  }

  private func displayFeatureName(_ feature: String) -> String {
    switch feature {
    case "tickets":
      return "Tickets"
    case "cloudflare":
      return "Cloudflare"
    case "tailscale":
      return "Tailscale"
    default:
      if let trimmed = feature.split(separator: ".").last {
        return trimmed.capitalized
      }
      return feature.capitalized
    }
  }

  private func displayRuntimeStatus(_ status: ProjectRuntimeStatus) -> String {
    switch status {
    case .running:
      return "Running"
    case .stopped:
      return "Stopped"
    case .missing:
      return "Missing"
    case .unknown:
      return "Unknown"
    case .notConfigured:
      return "Not configured"
    }
  }
}
