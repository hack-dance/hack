import XCTest

@testable import HackDesktopModels

final class RailwayBootstrapRequestTests: XCTestCase {
  func testRailwayProjectCanBeNil() {
    let request = RailwayBootstrapRequest(
      railwayProject: nil,
      railwayService: nil,
      railwayEnvironment: "production",
      railwayWorkspace: nil,
      createService: true,
      railwayImage: "hackdance/hack:latest",
      railwayBin: nil,
      nodeName: "node-a",
      endpoint: nil,
      labels: ["railway", "linux"],
      defaultNode: false,
      domainPort: nil,
      initRetries: nil,
      privateNetworking: true,
      tailscaleAuthKey: nil,
      tailscaleHostname: nil,
      tailscaleTags: []
    )

    XCTAssertNil(request.railwayProject)
  }

  func testRailwayProjectValueIsRetainedWhenProvided() {
    let request = RailwayBootstrapRequest(
      railwayProject: "my-project",
      railwayService: "svc-a",
      railwayEnvironment: "production",
      railwayWorkspace: "ws-a",
      createService: false,
      railwayImage: nil,
      railwayBin: nil,
      nodeName: nil,
      endpoint: nil,
      labels: [],
      defaultNode: true,
      domainPort: 443,
      initRetries: 2,
      privateNetworking: false,
      tailscaleAuthKey: nil,
      tailscaleHostname: nil,
      tailscaleTags: []
    )

    XCTAssertEqual(request.railwayProject, "my-project")
  }
}
