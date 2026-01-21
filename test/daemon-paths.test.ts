import { describe, expect, test } from "bun:test"
import { resolveDaemonPaths } from "../src/daemon/paths.ts"
import { DAEMON_LAUNCHD_PLIST_FILENAME } from "../src/constants.ts"

describe("daemon paths", () => {
  test("resolves paths with custom home", () => {
    const paths = resolveDaemonPaths({ home: "/Users/testuser" })

    expect(paths.root).toBe("/Users/testuser/.hack/daemon")
    expect(paths.socketPath).toBe("/Users/testuser/.hack/daemon/hackd.sock")
    expect(paths.pidPath).toBe("/Users/testuser/.hack/daemon/hackd.pid")
    expect(paths.logPath).toBe("/Users/testuser/.hack/daemon/hackd.log")
  })

  test("resolves launchd plist path in LaunchAgents", () => {
    const paths = resolveDaemonPaths({ home: "/Users/testuser" })

    expect(paths.launchdPlistPath).toBe(
      `/Users/testuser/Library/LaunchAgents/${DAEMON_LAUNCHD_PLIST_FILENAME}`
    )
    expect(paths.launchdPlistPath).toContain("dance.hack.hackd.plist")
  })

  test("resolves launchd stdout/stderr paths in daemon dir", () => {
    const paths = resolveDaemonPaths({ home: "/Users/testuser" })

    expect(paths.launchdStdoutPath).toBe("/Users/testuser/.hack/daemon/hackd.stdout.log")
    expect(paths.launchdStderrPath).toBe("/Users/testuser/.hack/daemon/hackd.stderr.log")
  })

  test("handles home with trailing spaces", () => {
    const paths = resolveDaemonPaths({ home: "/Users/testuser  " })

    expect(paths.root).toBe("/Users/testuser/.hack/daemon")
  })
})
