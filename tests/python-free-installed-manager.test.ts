import { expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPrereleaseManager } from "../scripts/build-prerelease-manager.ts";
import { digest, hash, jsonBytes } from "../scripts/installer/integrity.ts";

const supported = process.platform === "darwin" && process.arch === "arm64";
const EXECUTOR = `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc > 1 && strcmp(argv[1], "--candidate-root") == 0) {
    const char *kind = getenv("FIXTURE_STATUS");
    if (kind && strcmp(kind, "error") == 0) return 7;
    if (kind && strcmp(kind, "malformed") == 0) { puts("not json"); return 0; }
    if (kind && strcmp(kind, "active") == 0) { puts("{\\"phase\\":\\"running\\",\\"process_alive\\":true}"); return 0; }
    puts("{\\"phase\\":\\"uninitialized\\",\\"process_alive\\":false}"); return 0;
  }
  if (argc > 1 && strcmp(argv[1], "wait-for-signal") == 0) { puts("ready"); fflush(stdout); pause(); return 9; }
  printf("fixture-cli:%s:%s\\n", getenv("HACK_RUNTIME_BACKEND"), getenv("HACK_HOME"));
  return argc > 1 && strcmp(argv[1], "exit-seven") == 0 ? 7 : 0;
}`;

test.skipIf(!supported)(
  "compiled installed manager and launcher run with no Python/Bun, preserve stable and reject errors",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "hack-standalone-")));
    try {
      const home = join(root, "home");
      const path = join(root, "path");
      const temp = join(root, "temp");
      for (const dir of [home, path, temp]) {
        mkdirSync(dir, { mode: 0o700 });
      }
      symlinkSync("/usr/bin/dirname", join(path, "dirname"));
      writeFileSync(join(path, "hack"), "#!/bin/sh\necho stable-original\n", {
        mode: 0o755,
      });
      const manager = join(root, "manager");
      await buildPrereleaseManager(manager);
      const executor = join(root, "executor");
      const compiled = Bun.spawnSync(
        ["/usr/bin/cc", "-x", "c", "-", "-o", executor],
        {
          stdin: Buffer.from(EXECUTOR),
          stdout: "pipe",
          stderr: "pipe",
          timeout: 30_000,
          env: {
            ...process.env,
            CLANG_MODULE_CACHE_PATH: join(root, "clang-cache"),
          },
        }
      );
      expect(compiled.stderr.toString()).toBe("");
      expect(compiled.exitCode).toBe(0);
      expect(
        Bun.spawnSync(
          ["/usr/bin/codesign", "--force", "--sign", "-", executor],
          { timeout: 10_000 }
        ).exitCode
      ).toBe(0);
      const archive = (version: string, unsigned = false) => {
        const bundle = join(root, `bundle-${version}`);
        mkdirSync(bundle, { mode: 0o700 });
        copyFileSync(executor, join(bundle, "hack-native"));
        copyFileSync(executor, join(bundle, "hack-cli"));
        if (unsigned) {
          writeFileSync(join(bundle, "hack-cli"), "#!/bin/sh\nexit 0\n");
        }
        chmodSync(join(bundle, "hack-native"), 0o755);
        chmodSync(join(bundle, "hack-cli"), 0o755);
        const files = [
          "hack-native",
          "hack-cli",
          "hack-v5",
          "hack-relay-guest",
          "provider-pins.json",
          "README.md",
          "prerelease.json",
        ];
        writeFileSync(
          join(bundle, "hack-v5"),
          '#!/bin/sh\nexec "$(dirname "$0")/hack-cli" "$@"\n',
          { mode: 0o755 }
        );
        writeFileSync(join(bundle, "hack-relay-guest"), "fixture guest", {
          mode: 0o755,
        });
        writeFileSync(join(bundle, "provider-pins.json"), "{}", {
          mode: 0o600,
        });
        writeFileSync(join(bundle, "README.md"), "fixture", { mode: 0o600 });
        writeFileSync(
          join(bundle, "prerelease.json"),
          jsonBytes({
            schema: "hack.prerelease/v1",
            version,
            tag: `v${version}`,
            platform: "darwin-arm64",
            source_revision: "a".repeat(40),
          }),
          { mode: 0o600 }
        );
        writeFileSync(
          join(bundle, "SHA256SUMS"),
          files
            .map(
              (name) => `${hash(readFileSync(join(bundle, name)))}  ${name}\n`
            )
            .join(""),
          { mode: 0o600 }
        );
        const target = join(root, `${version}.tar.gz`);
        expect(
          Bun.spawnSync(
            [
              "/usr/bin/tar",
              "--format=ustar",
              "-czf",
              target,
              "-C",
              bundle,
              ...files,
              "SHA256SUMS",
            ],
            { env: { ...process.env, COPYFILE_DISABLE: "1" }, timeout: 10_000 }
          ).exitCode
        ).toBe(0);
        return { target, checksum: digest(target) };
      };
      const first = archive("5.0.0-next.1");
      const second = archive("5.0.0-next.2");
      const channel = join(home, ".hack-next");
      const env = {
        HOME: home,
        PATH: path,
        TMPDIR: temp,
        HACK_HOME: join(root, "caller-home"),
        HACK_NATIVE_BINARY: "/foreign",
        HACK_NATIVE_HOME: "/foreign",
        HACK_GLOBAL_CONFIG_PATH: "/foreign",
      };
      const run = (args: string[], extra: NodeJS.ProcessEnv = {}) =>
        Bun.spawnSync([manager, "--root", channel, ...args], {
          cwd: root,
          env: { ...env, ...extra },
          timeout: 30_000,
          stdout: "pipe",
          stderr: "pipe",
        });
      const install = run([
        "install",
        "--version",
        "5.0.0-next.1",
        "--archive",
        first.target,
        "--sha256",
        first.checksum,
      ]);
      expect(install.stderr.toString()).toBe("");
      expect(install.exitCode).toBe(0);
      expect(install.stdout.toString()).toContain('"selected":"5.0.0-next.1"');
      writeFileSync(
        join(root, ".env"),
        "HACK_RUNTIME_BACKEND=invalid-from-dotenv\n"
      );
      writeFileSync(
        join(root, "bunfig.toml"),
        "this is deliberately not valid TOML [[["
      );
      expect(run(["run", "hello"]).exitCode).toBe(0);
      expect(Bun.which("python3", { PATH: path })).toBeNull();
      expect(Bun.which("bun", { PATH: path })).toBeNull();
      const launcher = join(channel, "bin/hack-next");
      expect(
        Bun.spawnSync([launcher, "--manager", "--help"], {
          env,
          timeout: 30_000,
        }).stdout.toString()
      ).toContain("hack-next --manager");
      const launch = Bun.spawnSync([launcher, "hello"], {
        env,
        timeout: 30_000,
      });
      expect(launch.stderr.toString()).toBe("");
      expect(launch.exitCode).toBe(0);
      expect(launch.stdout.toString()).toContain(
        `fixture-cli:native:${channel}/versions/5.0.0-next.1/cli-home`
      );
      expect(
        Bun.spawnSync([launcher, "exit-seven"], { env, timeout: 30_000 })
          .exitCode
      ).toBe(7);
      const waiting = Bun.spawn([launcher, "wait-for-signal"], {
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15_000,
      });
      try {
        const reader = waiting.stdout.getReader();
        const ready = await reader.read();
        expect(new TextDecoder().decode(ready.value)).toContain("ready");
        reader.releaseLock();
        expect(run(["stable"]).stderr.toString()).toContain("active");
        waiting.kill("SIGTERM");
        expect(await waiting.exited).toBe(143);
      } finally {
        if (waiting.exitCode === null) {
          waiting.kill("SIGTERM");
          await waiting.exited;
        }
      }
      const compose = Bun.spawnSync([launcher, "hello"], {
        env: { ...env, HACK_RUNTIME_BACKEND: "compose" },
        timeout: 30_000,
      });
      expect(compose.stdout.toString()).toContain(
        `fixture-cli:compose:${env.HACK_HOME}`
      );
      expect(
        Bun.spawnSync([launcher], {
          env: { ...env, HACK_RUNTIME_BACKEND: "unknown" },
          timeout: 30_000,
        }).exitCode
      ).toBe(1);
      const before = readFileSync(join(channel, ".selection.json"));
      const unsigned = archive("5.0.0-next.3", true);
      const unsignedResult = run([
        "upgrade",
        "--version",
        "5.0.0-next.3",
        "--archive",
        unsigned.target,
        "--sha256",
        unsigned.checksum,
      ]);
      expect(unsignedResult.stderr.toString()).toContain(
        "code signature failed"
      );
      expect(unsignedResult.exitCode).toBe(1);
      expect(readFileSync(join(channel, ".selection.json"))).toEqual(before);
      for (const status of ["error", "active", "malformed"]) {
        const rejected = run(
          [
            "upgrade",
            "--version",
            "5.0.0-next.2",
            "--archive",
            second.target,
            "--sha256",
            second.checksum,
          ],
          { FIXTURE_STATUS: status }
        );
        expect(rejected.exitCode).toBe(1);
        expect(readFileSync(join(channel, ".selection.json"))).toEqual(before);
      }
      const upgraded = run([
        "upgrade",
        "--version",
        "5.0.0-next.2",
        "--archive",
        second.target,
        "--sha256",
        second.checksum,
      ]);
      expect(upgraded.stderr.toString()).toBe("");
      expect(upgraded.exitCode).toBe(0);
      expect(run(["rollback"]).stdout.toString()).toContain(
        '"selected":"5.0.0-next.1"'
      );
      const status = Bun.spawnSync([launcher, "--manager", "status"], {
        env,
        timeout: 30_000,
      });
      expect(status.exitCode).toBe(0);
      expect(status.stdout.toString()).toContain('"selected":"5.0.0-next.1"');
      expect(run(["stable"]).exitCode).toBe(0);
      expect(run(["run"]).stderr.toString()).toContain("No candidate selected");
      expect(
        Bun.spawnSync([join(path, "hack")], {
          env,
          timeout: 10_000,
        }).stdout.toString()
      ).toBe("stable-original\n");
      expect(readdirSync(join(channel, "versions"))).toHaveLength(2);
      // No shell profile, stable binary or global configuration was created.
      expect(readdirSync(home)).toEqual([".hack-next"]);
      // A changed installed executable must fail before launch and leave receipt untouched.
      const selection = readFileSync(join(channel, ".selection.json"));
      writeFileSync(
        join(channel, "versions/5.0.0-next.1/bundle/hack-cli"),
        "tampered"
      );
      expect(run(["status"]).stderr.toString()).toContain("checksum mismatch");
      expect(readFileSync(join(channel, ".selection.json"))).toEqual(selection);
      expect(existsSync(join(home, ".bashrc"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  120_000
);
