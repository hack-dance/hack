import { join } from "node:path";
import { createMonorepoFixture } from "../fixture.ts";
import { expect, expectExit, runCommand, type Scenario } from "../harness.ts";
import { downBestEffort, requireDockerPreconditions } from "./docker-shared.ts";

/** Exercise actual mounts and installer failure before consumer replacement. */
export const dependencyCacheScenario: Scenario = {
  name: "dependency-cache",
  tier: "docker",
  summary: "run/up/restart share initialized caches across lockfile changes",
  run: async (ctx) => {
    await requireDockerPreconditions({ ctx });
    const fixture = await createMonorepoFixture({
      parentDir: ctx.tempRoot,
      withHackConfig: true,
      lifecycle: { disableInternal: true },
    });
    const project = `${fixture.name}--cache`;
    await Bun.write(join(fixture.root, "bun.lock"), "lock-one\n");
    await Bun.write(
      join(fixture.root, "initialize.sh"),
      `#!/bin/sh
set -eu
test ! -e /workspace/fail-install
if cmp -s /workspace/bun.lock /cache/lock; then exit 0; fi
cp /workspace/bun.lock /cache/lock
`
    );
    await Bun.write(
      join(fixture.hackDir, "docker-compose.yml"),
      `name: ${fixture.name}
services:
  deps:
    image: alpine:3.20
    command: [sh, /workspace/initialize.sh]
    labels:
      hack.dependencies.bootstrap: "true"
      hack.dependencies.cache-volume: dependencies
      hack.dependencies.lockfiles: bun.lock
    volumes:
      - ..:/workspace:ro
      - dependencies:/cache
  app:
    image: alpine:3.20
    command: [sh, -c, "cp /cache/lock /tmp/loaded && exec sleep 3600"]
    volumes:
      - dependencies:/cache:ro
    depends_on:
      deps:
        condition: service_completed_successfully
  unrelated:
    image: alpine:3.20
    command: [sleep, "3600"]
volumes:
  dependencies: {}
`
    );
    const cli = async (args: readonly string[]) =>
      await ctx.cli({
        args: [args[0]!, "--branch", "cache", ...args.slice(1)],
        cwd: fixture.root,
        timeoutMs: 180_000,
      });
    const probe = async (service: string, args: readonly string[]) =>
      await runCommand({
        argv: ["docker", "exec", `${project}-${service}-1`, ...args],
        cwd: fixture.root,
      });
    const checkLoaded = async (expected: string) => {
      const result = await probe("app", ["cat", "/tmp/loaded"]);
      expectExit({
        result,
        codes: [0],
        message: "consumer must be running with initialized dependencies",
      });
      expect({
        that: result.stdout.trim() === expected,
        message: `consumer loaded ${expected}`,
        result,
      });
    };
    const rememberVolume = async () => {
      const result = await runCommand({
        argv: [
          "docker",
          "inspect",
          `${project}-app-1`,
          "--format",
          '{{range .Mounts}}{{if eq .Destination "/cache"}}{{.Name}}{{end}}{{end}}',
        ],
        cwd: fixture.root,
      });
      expectExit({
        result,
        codes: [0],
        message: "inspect owned consumer mount",
      });
      const name = result.stdout.trim();
      expect({
        that: name.startsWith(`hack-cache-${fixture.name}-dependencies-`),
        message: "consumer uses fingerprinted cache",
        result,
      });
      return name;
    };
    try {
      const cold = await cli(["up", "--json", "app", "unrelated"]);
      expectExit({
        result: cold,
        codes: [0],
        message: "cold scoped up initializes dependencies",
      });
      expect({
        that: JSON.parse(cold.stdout).ok === true,
        message: "bootstrap output preserves JSON stdout",
        result: cold,
      });
      await checkLoaded("lock-one");
      const firstVolume = await rememberVolume();
      const installer = await cli(["run", "deps", "cat", "/cache/lock"]);
      expectExit({
        result: installer,
        codes: [0],
        message: "one-off installer sees consumer cache",
      });
      expect({
        that: installer.stdout.trim() === "lock-one",
        message: "run uses identical cache",
        result: installer,
      });
      const consumerRun = await ctx.cli({
        args: ["run", "--branch", "cache", "app", "cat", "/cache/lock"],
        cwd: fixture.root,
        env: { HACK_LOGGER: "clack" },
        timeoutMs: 180_000,
      });
      expectExit({
        result: consumerRun,
        codes: [0],
        message: "consumer run bootstraps its cache",
      });
      expect({
        that: consumerRun.stdout.trim() === "lock-one",
        message: "Clack bootstrap diagnostics stay off consumer stdout",
        result: consumerRun,
      });
      await cli(["run", "deps", "touch", "/cache/warm-sentinel"]);
      expectExit({
        result: await cli(["restart", "app"]),
        codes: [0],
        message: "warm restart reuses cache",
      });
      expectExit({
        result: await probe("app", ["test", "-f", "/cache/warm-sentinel"]),
        codes: [0],
        message: "warm cache preserved",
      });
      expect({
        that: (await rememberVolume()) === firstVolume,
        message: "warm volume identity preserved",
      });
      await Bun.write(join(fixture.root, "bun.lock"), "lock-two\n");
      expectExit({
        result: await cli(["restart", "app"]),
        codes: [0],
        message: "restart initializes new fingerprint",
      });
      await checkLoaded("lock-two");
      expect({
        that: (await rememberVolume()) !== firstVolume,
        message: "lock change selects distinct initialized cache",
      });
      await Bun.write(join(fixture.root, "bun.lock"), "lock-three\n");
      expectExit({
        result: await cli(["up", "--detach", "app"]),
        codes: [0],
        message: "scoped up initializes changed fingerprint",
      });
      await checkLoaded("lock-three");
      await rememberVolume();
      await Bun.write(join(fixture.root, "bun.lock"), "failed-lock\n");
      await Bun.write(join(fixture.root, "fail-install"), "fail");
      for (const operation of [
        ["restart", "app"],
        ["up", "--detach", "app"],
      ]) {
        const failed = await cli(operation);
        expect({
          that: failed.exitCode !== 0,
          message: "installer failure rejects consumer replacement",
          result: failed,
        });
        await checkLoaded("lock-three");
      }
      expectExit({
        result: await probe("unrelated", ["true"]),
        codes: [0],
        message: "unrelated service remains running",
      });
      ctx.log(
        "verified cold and warm caches, run mount parity, lockfile transitions, and failure isolation"
      );
    } finally {
      await downBestEffort({ ctx, fixture, branches: ["cache"] });
      // Only this random fixture's volumes, including a failed initialization.
      const volumes = await runCommand({
        argv: [
          "docker",
          "volume",
          "ls",
          "--format",
          "{{.Name}}",
          "--filter",
          `name=hack-cache-${fixture.name}-dependencies-`,
        ],
        cwd: fixture.root,
      });
      for (const name of volumes.stdout.trim().split("\n")) {
        if (name.startsWith(`hack-cache-${fixture.name}-dependencies-`)) {
          await runCommand({
            argv: ["docker", "volume", "rm", name],
            cwd: fixture.root,
          });
        }
      }
    }
  },
};
