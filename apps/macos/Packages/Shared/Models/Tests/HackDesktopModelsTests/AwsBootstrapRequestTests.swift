import XCTest

@testable import HackDesktopModels

final class AwsBootstrapRequestTests: XCTestCase {
  func testAwsBootstrapRequestAllowsInstanceIdSelection() {
    let request = AwsBootstrapRequest(
      instanceId: "i-1234567890",
      instanceTagKey: nil,
      instanceTagValue: nil,
      region: "us-east-1",
      profile: nil,
      bootstrapCommand: nil,
      source: "ec2-user@example.internal",
      endpoint: "https://node.example.internal",
      nodeName: "aws-node-a",
      labels: ["aws", "linux"],
      defaultNode: true
    )

    XCTAssertEqual(request.instanceId, "i-1234567890")
    XCTAssertNil(request.instanceTagValue)
    XCTAssertEqual(request.labels, ["aws", "linux"])
    XCTAssertTrue(request.defaultNode)
  }

  func testAwsBootstrapRequestRetainsTagSelectorWhenProvided() {
    let request = AwsBootstrapRequest(
      instanceId: nil,
      instanceTagKey: "Name",
      instanceTagValue: "qa-runner",
      region: "us-east-2",
      profile: "sandbox",
      bootstrapCommand: "sudo systemctl restart hack-node",
      source: "ubuntu@qa-runner.internal",
      endpoint: "https://qa-runner.internal",
      nodeName: nil,
      labels: [],
      defaultNode: false
    )

    XCTAssertNil(request.instanceId)
    XCTAssertEqual(request.instanceTagKey, "Name")
    XCTAssertEqual(request.instanceTagValue, "qa-runner")
    XCTAssertEqual(request.bootstrapCommand, "sudo systemctl restart hack-node")
    XCTAssertFalse(request.defaultNode)
  }
}
