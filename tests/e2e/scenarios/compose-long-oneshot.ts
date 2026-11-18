import { join } from "node:path";
import { createMonorepoFixture } from "../fixture.ts";
import { expect, expectExit, runCommand, type Scenario } from "../harness.ts";

/**
 * HACK-2310: a one-shot dependency that runs longer than the default 90 s
 * start budget (a cold database's migrations). `hack up -d` must keep
 * waiting while it runs and end with every service started: the one-shot
 * exited 0 and its `service_completed_successfully` dependent running, not
 * left in Created.
 */
export const composeLongOneshotScenario: Scenario = {
  name: "compose-long-oneshot",
  tier: "docker",
  summary: "a 150 s one-shot dependency outlasts the start budget",
  run: async (ctx) => {
    const seconds = Number(
      process.env.HACK_E2E_COMPOSE_ONESHOT_SECONDS ?? "150"
    );
    expect({
      that: Number.isInteger(seconds) && seconds >= 1 && seconds <= 600,
      message: "One-shot duration must be between 1 and 600 seconds",
    });
    const fixture = await createMonorepoFixture({
      parentDir: ctx.tempRoot,
      withHackConfig: true,
      lifecycle: { disableInternal: true },
    });
    const composeFile = join(fixture.hackDir, "docker-compose.yml");
    const docker = async (args: readonly string[]) => {
      const result = await runCommand({
        argv: ["docker", ...args],
        cwd: ctx.tempRoot,
        timeoutMs: 60_000,
      });
      expectExit({
        result,
        codes: [0],
        message: `Docker ${args[0]} must succeed`,
      });
      return result.stdout.trim();
    };
    const cli = (args: readonly string[], timeoutMs: number) =>
      ctx.cli({
        args,
        cwd: fixture.root,
        timeoutMs,
        env: { HACK_RUNTIME_BACKEND: "compose", HACK_EXECUTION_MODE: "slim" },
      });
    const image = "alpine:3.20";
    // Admission and cleanup are owned by the repository's isolated Docker harness.
    await docker(["image", "inspect", image, "--format", "{{.Id}}"]);
    await Bun.write(
      composeFile,
      JSON.stringify({
        name: fixture.name,
        services: {
          migrate: {
            image,
            pull_policy: "never",
            restart: "no",
            command: ["sh", "-c", `sleep ${seconds}`],
          },
          app: {
            image,
            pull_policy: "never",
            command: ["sh", "-c", "sleep 3600"],
            depends_on: {
              migrate: { condition: "service_completed_successfully" },
            },
          },
        },
        networks: { default: { internal: true } },
      })
    );
    const serviceState = async (service: string) => {
      const id = await docker([
        "ps",
        "-aq",
        "--filter",
        `label=com.docker.compose.project=${fixture.name}`,
        "--filter",
        `label=com.docker.compose.service=${service}`,
      ]);
      return JSON.parse(
        await docker(["inspect", id, "--format", "{{json .State}}"])
      ) as { Status?: string; ExitCode?: number };
    };
    try {
      const started = Date.now();
      // The default 90 s budget applies: no host variable or project setting.
      const up = await cli(["up", "-d", "--json"], (seconds + 120) * 1000);
      const elapsedMs = Date.now() - started;
      expectExit({
        result: up,
        codes: [0],
        message: `Detached up with a ${seconds} s one-shot must succeed`,
      });
      const migrate = await serviceState("migrate");
      const app = await serviceState("app");
      expect({
        that: migrate.Status === "exited" && migrate.ExitCode === 0,
        message: "The one-shot must have run to completion",
      });
      expect({
        that: app.Status === "running",
        message: "Its dependent must be running, not left in Created",
      });
      ctx.log(
        `detached up with a ${seconds} s one-shot succeeded in ${Math.round(elapsedMs / 1000)} s`
      );
    } finally {
      const down = await cli(["down"], 120_000);
      expectExit({ result: down, codes: [0], message: "Owned fixture down" });
    }
  },
};
