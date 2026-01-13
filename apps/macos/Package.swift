// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "HackDesktop",
  platforms: [.macOS(.v14)],
  products: [
    .library(name: "HackDesktopModels", targets: ["HackDesktopModels"]),
    .library(name: "HackCLIService", targets: ["HackCLIService"]),
    .library(name: "DashboardFeature", targets: ["DashboardFeature"])
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
      name: "DashboardFeature",
      dependencies: ["HackCLIService", "HackDesktopModels"],
      path: "Packages/Features/DashboardFeature/Sources/DashboardFeature"
    ),
    .testTarget(
      name: "HackDesktopModelsTests",
      dependencies: ["HackDesktopModels"],
      path: "Packages/Shared/Models/Tests/HackDesktopModelsTests"
    )
  ]
)
