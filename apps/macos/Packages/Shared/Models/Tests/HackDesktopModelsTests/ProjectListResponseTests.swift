import XCTest

@testable import HackDesktopModels

final class ProjectListResponseTests: XCTestCase {
  func testDecodesProjectListResponse() throws {
    let json = """
    {
      "generated_at": "2026-01-13T00:00:00Z",
      "include_global": true,
      "include_unregistered": false,
      "runtime_ok": true,
      "runtime_error": null,
      "runtime_checked_at": "2026-01-13T00:00:01Z",
      "projects": [
        {
          "project_id": "proj-1",
          "name": "hack-cli",
          "dev_host": "hack-cli.test",
          "repo_root": "/repo",
          "project_dir": "/repo",
          "defined_services": ["api"],
          "kind": "registered",
          "status": "running"
        }
      ]
    }
    """

    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase

    let data = Data(json.utf8)
    let response = try decoder.decode(ProjectListResponse.self, from: data)

    XCTAssertEqual(response.generatedAt, "2026-01-13T00:00:00Z")
    XCTAssertEqual(response.runtimeOk, true)
    XCTAssertEqual(response.projects.count, 1)
    XCTAssertEqual(response.projects.first?.name, "hack-cli")
    XCTAssertEqual(response.projects.first?.status, .running)
  }
}
