import { describe, expect, test } from "bun:test"
import { renderLaunchdPlist } from "../src/daemon/launchd.ts"
import { DAEMON_LAUNCHD_LABEL } from "../src/constants.ts"

describe("launchd plist generation", () => {
  test("renders plist with RunAtLoad false", () => {
    const plist = renderLaunchdPlist({
      hackBinPath: "/usr/local/bin/hack",
      home: "/Users/testuser",
      runAtLoad: false,
      guiSessionOnly: true,
      stdoutPath: "/Users/testuser/.hack/daemon/hackd.stdout.log",
      stderrPath: "/Users/testuser/.hack/daemon/hackd.stderr.log"
    })

    expect(plist).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(plist).toContain(`<string>${DAEMON_LAUNCHD_LABEL}</string>`)
    expect(plist).toContain("<string>/usr/local/bin/hack</string>")
    expect(plist).toContain("<string>daemon</string>")
    expect(plist).toContain("<string>start</string>")
    expect(plist).toContain("<string>--foreground</string>")
    expect(plist).toContain("<key>RunAtLoad</key>")
    expect(plist).toContain("<false/>")
    expect(plist).toContain("<key>WorkingDirectory</key>")
    expect(plist).toContain("<string>/Users/testuser</string>")
    expect(plist).toContain("<key>StandardOutPath</key>")
    expect(plist).toContain("<key>StandardErrorPath</key>")
    expect(plist).toContain("<key>LimitLoadToSessionType</key>")
    expect(plist).toContain("<string>Aqua</string>")
  })

  test("renders plist with RunAtLoad true", () => {
    const plist = renderLaunchdPlist({
      hackBinPath: "/opt/homebrew/bin/hack",
      home: "/Users/developer",
      runAtLoad: true,
      guiSessionOnly: true,
      stdoutPath: "/Users/developer/.hack/daemon/hackd.stdout.log",
      stderrPath: "/Users/developer/.hack/daemon/hackd.stderr.log"
    })

    expect(plist).toContain("<key>RunAtLoad</key>")
    expect(plist).toContain("<true/>")
    expect(plist).toContain("<string>/opt/homebrew/bin/hack</string>")
    expect(plist).toContain("<string>/Users/developer</string>")
  })

  test("renders plist without GUI session restriction", () => {
    const plist = renderLaunchdPlist({
      hackBinPath: "/usr/local/bin/hack",
      home: "/Users/testuser",
      runAtLoad: false,
      guiSessionOnly: false,
      stdoutPath: "/Users/testuser/.hack/daemon/hackd.stdout.log",
      stderrPath: "/Users/testuser/.hack/daemon/hackd.stderr.log"
    })

    expect(plist).not.toContain("<key>LimitLoadToSessionType</key>")
    expect(plist).not.toContain("<string>Aqua</string>")
  })

  test("includes KeepAlive with SuccessfulExit false", () => {
    const plist = renderLaunchdPlist({
      hackBinPath: "/usr/local/bin/hack",
      home: "/Users/testuser",
      runAtLoad: false,
      guiSessionOnly: true,
      stdoutPath: "/Users/testuser/.hack/daemon/hackd.stdout.log",
      stderrPath: "/Users/testuser/.hack/daemon/hackd.stderr.log"
    })

    expect(plist).toContain("<key>KeepAlive</key>")
    expect(plist).toContain("<key>SuccessfulExit</key>")
    expect(plist).toContain("<false/>")
  })

  test("includes PATH with common binary locations", () => {
    const plist = renderLaunchdPlist({
      hackBinPath: "/usr/local/bin/hack",
      home: "/Users/testuser",
      runAtLoad: false,
      guiSessionOnly: true,
      stdoutPath: "/Users/testuser/.hack/daemon/hackd.stdout.log",
      stderrPath: "/Users/testuser/.hack/daemon/hackd.stderr.log"
    })

    expect(plist).toContain("<key>PATH</key>")
    expect(plist).toContain("/usr/local/bin")
    expect(plist).toContain("/opt/homebrew/bin")
    expect(plist).toContain("/usr/bin")
    expect(plist).toContain("/bin")
    expect(plist).toContain(".bun/bin")
    expect(plist).toContain(".hack/bin")
  })

  test("plist is valid XML structure", () => {
    const plist = renderLaunchdPlist({
      hackBinPath: "/usr/local/bin/hack",
      home: "/Users/testuser",
      runAtLoad: true,
      guiSessionOnly: true,
      stdoutPath: "/Users/testuser/.hack/daemon/hackd.stdout.log",
      stderrPath: "/Users/testuser/.hack/daemon/hackd.stderr.log"
    })

    expect(plist).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/)
    expect(plist).toContain("<!DOCTYPE plist")
    expect(plist).toContain('<plist version="1.0">')
    expect(plist).toContain("</plist>")
    expect(plist).toContain("<dict>")
    expect(plist).toContain("</dict>")
  })
})

describe("daemon constants", () => {
  test("launchd label follows reverse-DNS convention", () => {
    expect(DAEMON_LAUNCHD_LABEL).toBe("dance.hack.hackd")
    expect(DAEMON_LAUNCHD_LABEL).toMatch(/^[a-z]+\.[a-z]+\.[a-z]+$/)
  })
})
