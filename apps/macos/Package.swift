// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "HackDesktop",
  platforms: [.macOS(.v14)],
  products: [
    .library(name: "HackDesktopModels", targets: ["HackDesktopModels"]),
    .library(name: "HackCLIService", targets: ["HackCLIService"]),
    .library(name: "GhosttyTerminal", targets: ["GhosttyTerminal"]),
    .library(name: "DashboardFeature", targets: ["DashboardFeature"])
  ],
  dependencies: [
    .package(url: "https://github.com/gonzalezreal/swift-markdown-ui", from: "2.4.1"),
    .package(url: "https://github.com/raspu/Highlightr.git", from: "2.3.0")
  ],
  targets: [
    .target(
      name: "HackDesktopModels",
      path: "Packages/Shared/Models/Sources/HackDesktopModels"
    ),
    .target(
      name: "HackCLIService",
      dependencies: ["HackDesktopModels"],
      path: "Packages/Services/HackCLI/Sources/HackCLIService"
    ),
    .target(
      name: "GhosttyTerminal",
      path: "Packages/Services/GhosttyTerminal/Sources/GhosttyTerminal"
    ),
    .target(
      name: "DashboardFeature",
      dependencies: [
        "HackCLIService",
        "HackDesktopModels",
        "GhosttyTerminal",
        .product(name: "MarkdownUI", package: "swift-markdown-ui"),
        .product(name: "Highlightr", package: "Highlightr")
      ],
      path: "Packages/Features/DashboardFeature/Sources/DashboardFeature",
      exclude: [
        "TicketMarkdownCodeSyntaxHighlighter.swift",
      ]
    ),
    .testTarget(
      name: "HackDesktopModelsTests",
      dependencies: ["HackDesktopModels"],
      path: "Packages/Shared/Models/Tests/HackDesktopModelsTests"
    )
  ]
)
