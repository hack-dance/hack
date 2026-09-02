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
          "extensions_enabled": ["dance.hack.cloudflare"],
          "features": ["cloudflare"],
          "service_hosts": {
            "api": ["api.hack-cli.test", "api.hack-cli.test.gy"]
          },
          "runtime_configured": true,
          "runtime_status": "running",
          "sessions": [
            {
              "name": "hack-cli",
              "backend": "tmux",
              "source": "hack",
              "attached": true,
              "path": "/repo",
              "windows": 2,
              "created_at": 1735000000
            },
            {
              "name": "manual-scratch",
              "backend": "tmux",
              "source": "external",
              "attached": false,
              "path": "/repo",
              "windows": 1,
              "created_at": 1735000100
            },
            {
              "name": "hack-cli:research",
              "backend": "zellij",
              "source": "hack",
              "attached": false,
              "path": null,
              "windows": null,
              "created_at": null
            }
          ],
          "branch_runtime": [
            {
              "branch": "fix-seat-geometry",
              "runtime": {
                "project": "hack-cli--fix-seat-geometry",
                "working_dir": "/repo/.hack",
                "services": [
                  {
                    "service": "api",
                    "containers": [
                      {
                        "id": "abc123",
                        "state": "running",
                        "status": "Up 5m",
                        "name": "hack-cli--fix-seat-geometry-api-1",
                        "ports": "3000/tcp",
                        "working_dir": "/repo/.hack",
                        "image": "imbios/bun-node:latest",
                        "labels": {
                          "com.docker.compose.project": "hack-cli--fix-seat-geometry",
                          "com.docker.compose.service": "api"
                        },
                        "mounts": [
                          {
                            "type": "bind",
                            "source": "/repo",
                            "destination": "/app",
                            "mode": "",
                            "rw": true
                          }
                        ],
                        "networks": [
                          {
                            "name": "default",
                            "ip_address": "172.30.0.10",
                            "gateway": "172.30.0.1",
                            "aliases": ["api"]
                          }
                        ]
                      }
                    ]
                  }
                ]
              }
            }
          ],
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
    XCTAssertEqual(response.projects.first?.runtimeStatus, .running)
    XCTAssertEqual(response.projects.first?.serviceHosts?["api"], ["api.hack-cli.test", "api.hack-cli.test.gy"])
    XCTAssertEqual(response.projects.first?.sessions?.count, 3)
    XCTAssertEqual(response.projects.first?.sessions?.first?.name, "hack-cli")
    XCTAssertEqual(response.projects.first?.sessions?.first?.backend, .tmux)
    XCTAssertEqual(response.projects.first?.sessions?.first?.source, .hack)
    XCTAssertEqual(response.projects.first?.sessions?[2].backend, .zellij)
    XCTAssertEqual(response.projects.first?.branchRuntime?.first?.branch, "fix-seat-geometry")
    XCTAssertEqual(response.projects.first?.branchRuntime?.first?.runtime.project, "hack-cli--fix-seat-geometry")
    XCTAssertEqual(response.projects.first?.branchRuntime?.first?.runtime.services.first?.containers.first?.image, "imbios/bun-node:latest")
    XCTAssertEqual(response.projects.first?.branchRuntime?.first?.runtime.services.first?.containers.first?.mounts?.first?.destination, "/app")
    XCTAssertEqual(response.projects.first?.branchRuntime?.first?.runtime.services.first?.containers.first?.networks?.first?.ipAddress, "172.30.0.10")
  }
}
