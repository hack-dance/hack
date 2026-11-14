import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

// The launcher is a Linux guest artifact. macOS exercises it inside the real VM.
test.skipIf(
  process.platform !== "linux" || !Bun.which("zig") || !Bun.which("python3")
)(
  "interactive guest envelope never echoes private bytes and restores only on success",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "hack-interactive-launcher-"));
    try {
      const binary = join(root, "launcher");
      const env = privateCliEnv({ root });
      const version = Bun.spawnSync(["zig", "version"], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(version.exitCode).toBe(0);
      expect(version.stdout.toString().trim()).toBe("0.15.2");
      for (const cmd of [
        [
          "zig",
          "build-exe",
          resolve("packages/runtime-core/guest/environment-launcher.zig"),
          "-target",
          process.arch === "arm64" ? "aarch64-linux-musl" : "x86_64-linux-musl",
          "-O",
          "ReleaseSmall",
          `-femit-bin=${binary}`,
          "--cache-dir",
          join(root, "cache"),
          "--global-cache-dir",
          join(root, "global-cache"),
        ],
        [
          "python3",
          resolve("tests/fixtures/environment-launcher-tty.py"),
          binary,
        ],
      ]) {
        const child = Bun.spawn(cmd, {
          env,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          timeout: 60_000,
        });
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(stderr).toBe("");
        expect(code).toBe(0);
        if (cmd[0] === "python3") {
          expect(stdout).toBe("PTY handshake: seven cases passed\n");
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  125_000
);
