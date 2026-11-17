import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autostartTrustWarnings } from "../src/lib/autostart-trust-diagnostics.ts";

test("doctor explains automatic-start refusal for a real umask-002 checkout without repairing it", async () => {
  const home = await mkdtemp(join(tmpdir(), "hack-trust-doctor-"));
  try {
    const repoRoot = join(home, "project");
    const projectDir = join(repoRoot, ".hack");
    const previous = process.umask(0o002);
    try {
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, "hack.config.json"), "{}");
      mkdirSync(join(home, ".docker"), { mode: 0o700 });
      writeFileSync(join(home, ".docker/config.json"), "{}");
      mkdirSync(join(home, "bin"), { mode: 0o700 });
    } finally {
      process.umask(previous);
    }
    const warnings = await autostartTrustWarnings({
      home,
      executablePath: join(home, "bin"),
      projects: [
        {
          id: "example",
          name: "example",
          repoRoot,
          projectDir,
          projectDirName: ".hack",
          createdAt: "2026-01-01T00:00:00Z",
          autostart: {
            branch: null,
            paused: false,
            lastResult: null,
            lastAttemptBootId: null,
          },
        },
      ],
    });
    expect(warnings).toEqual(["checkout_untrusted", "docker_config_untrusted"]);
    expect(
      (await Bun.file(join(projectDir, "hack.config.json")).stat()).mode & 0o777
    ).toBe(0o664);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
