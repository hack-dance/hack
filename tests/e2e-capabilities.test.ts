import { describe, expect, test } from "bun:test";

import { resolveExecutableCapability } from "./e2e/capabilities.ts";

describe("resolveExecutableCapability", () => {
  test("runs when the executable is available", () => {
    expect(
      resolveExecutableCapability({
        executable: "tmux",
        executablePath: "/usr/bin/tmux",
        required: true,
        installHint: "install tmux",
      })
    ).toEqual({ kind: "available" });
  });

  test("skips an unavailable optional local capability", () => {
    expect(
      resolveExecutableCapability({
        executable: "tmux",
        executablePath: null,
        required: false,
        installHint: "install tmux",
      })
    ).toEqual({ kind: "skip", reason: "tmux unavailable (install tmux)" });
  });

  test("fails an unavailable capability required by CI", () => {
    expect(
      resolveExecutableCapability({
        executable: "tmux",
        executablePath: null,
        required: true,
        installHint: "install tmux",
      })
    ).toEqual({ kind: "fail", reason: "tmux unavailable (install tmux)" });
  });
});
