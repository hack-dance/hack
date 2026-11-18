import { join } from "node:path";
import { createMonorepoFixture } from "../fixture.ts";
import { expect, expectExit, runCommand, type Scenario } from "../harness.ts";
import { requireDockerPreconditions } from "./docker-shared.ts";

/**
 * HACK-2340: `COMPOSE_PROFILES` in the managed env starts a profiled service;
 * `hack down` must stop it too, for the primary checkout and for a branch
 * instance, even when the env no longer selects that profile, and its JSON
 * must report what it observed.
 */
export const downProfilesScenario: Scenario = {
  name: "down-profiles",
  tier: "docker",
  summary:
    "down stops profiled services started through managed COMPOSE_PROFILES",
  run: async (ctx) => {
    await requireDockerPreconditions({ ctx });
    const fixture = await createMonorepoFixture({
      parentDir: ctx.tempRoot,
      withHackConfig: true,
      lifecycle: { disableInternal: true },
    });
    const image = "alpine:3.20";
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
    const cli = (args: readonly string[]) =>
      ctx.cli({
        args,
        cwd: fixture.root,
        timeoutMs: 180_000,
        env: { HACK_RUNTIME_BACKEND: "compose", HACK_EXECUTION_MODE: "slim" },
      });
    const envFile = join(fixture.hackDir, "hack.env.default.yaml");
    const writeEnv = async (profiles: string | null) => {
      await Bun.write(
        envFile,
        profiles === null
          ? "version: 1\nsecretsprovider: project_key\nvalues:\n  global: {}\n"
          : `version: 1\nsecretsprovider: project_key\nvalues:\n  global:\n    COMPOSE_PROFILES: ${profiles}\n`
      );
    };
    await docker(["image", "inspect", image, "--format", "{{.Id}}"]);
    await Bun.write(
      join(fixture.hackDir, "docker-compose.yml"),
      JSON.stringify({
        name: fixture.name,
        services: {
          web: { image, pull_policy: "never", command: ["sleep", "3600"] },
          worker: {
            image,
            pull_policy: "never",
            command: ["sleep", "3600"],
            profiles: ["workers"],
          },
        },
        networks: { default: { internal: true } },
      })
    );
    const containersOf = async (project: string) =>
      (
        await docker([
          "ps",
          "-a",
          "--filter",
          `label=com.docker.compose.project=${project}`,
          "--format",
          '{{.Label "com.docker.compose.service"}}',
        ])
      )
        .split("\n")
        .filter(Boolean)
        .sort();
    const networksOf = async (project: string) =>
      (
        await docker([
          "network",
          "ls",
          "--filter",
          `label=com.docker.compose.project=${project}`,
          "--format",
          "{{.Name}}",
        ])
      )
        .split("\n")
        .filter(Boolean);

    const expectNothingLeft = async (opts: {
      readonly label: string;
      readonly project: string;
    }) => {
      const left = await containersOf(opts.project);
      expect({
        that: left.length === 0,
        message: `${opts.label}: no container left after down (found ${left.join(", ")})`,
      });
      const networks = await networksOf(opts.project);
      expect({
        that: networks.length === 0,
        message: `${opts.label}: the network is removed (found ${networks.join(", ")})`,
      });
    };
    const expectDownOk = (opts: {
      readonly label: string;
      readonly result: { readonly stdout: string };
      readonly stopped: readonly string[];
    }) => {
      const payload = JSON.parse(opts.result.stdout) as {
        readonly ok: boolean;
        readonly data?: {
          readonly services?: { readonly stopped?: readonly string[] };
        };
      };
      expect({
        that:
          payload.ok &&
          JSON.stringify(payload.data?.services?.stopped) ===
            JSON.stringify(opts.stopped),
        message: `${opts.label}: down reports ${opts.stopped.join(", ")} stopped`,
      });
    };

    const instances = [
      { label: "primary checkout", branchArgs: [], project: fixture.name },
      {
        label: "branch instance",
        branchArgs: ["--branch", "b"],
        project: `${fixture.name}--b`,
      },
    ] as const;
    try {
      for (const instance of instances) {
        await writeEnv("workers");
        const up = await cli(["up", "-d", ...instance.branchArgs]);
        expectExit({
          result: up,
          codes: [0],
          message: `${instance.label}: up`,
        });
        expect({
          that:
            JSON.stringify(await containersOf(instance.project)) ===
            JSON.stringify(["web", "worker"]),
          message: `${instance.label}: up starts the profiled worker`,
        });
        // The env no longer selects the profile: the recorded selection
        // still has to stop the worker.
        await writeEnv(null);
        const down = await cli(["down", "--json", ...instance.branchArgs]);
        expectExit({
          result: down,
          codes: [0],
          message: `${instance.label}: down`,
        });
        expectDownOk({
          label: instance.label,
          result: down,
          stopped: ["web", "worker"],
        });
        await expectNothingLeft(instance);
        ctx.log(`${instance.label}: down stopped web and the profiled worker`);
      }

      // No record and no profile in the env (a worker started with
      // --profile by an older Hack): only the leftover stop finds it.
      await writeEnv(null);
      const profiled = await cli(["up", "-d", "--profile", "workers"]);
      expectExit({
        result: profiled,
        codes: [0],
        message: "leftover stop: up --profile workers",
      });
      await Bun.write(
        join(fixture.hackDir, ".internal", "runtime-state.json"),
        '{"entries":[]}\n'
      );
      const swept = await cli(["down", "--json"]);
      expectExit({
        result: swept,
        codes: [0],
        message: "leftover stop: down",
      });
      expectDownOk({
        label: "leftover stop",
        result: swept,
        // The snapshot before down lists every container of the project.
        stopped: ["web", "worker"],
      });
      await expectNothingLeft({
        label: "leftover stop",
        project: fixture.name,
      });
      ctx.log("leftover stop: down removed the unrecorded profiled worker");
    } finally {
      await writeEnv("workers");
      for (const instance of instances) {
        await cli(["down", ...instance.branchArgs]);
        // Independent of the CLI under test, so a regression cannot leak the
        // profiled worker or its network (random e2e-<hex> project names).
        const ids = (
          await runCommand({
            argv: [
              "docker",
              "ps",
              "-aq",
              "--filter",
              `label=com.docker.compose.project=${instance.project}`,
            ],
            cwd: ctx.tempRoot,
            timeoutMs: 60_000,
          })
        ).stdout
          .split("\n")
          .filter(Boolean);
        if (ids.length > 0) {
          await runCommand({
            argv: ["docker", "rm", "-f", ...ids],
            cwd: ctx.tempRoot,
            timeoutMs: 60_000,
          });
        }
        for (const network of await networksOf(instance.project).catch(
          () => [] as string[]
        )) {
          await runCommand({
            argv: ["docker", "network", "rm", network],
            cwd: ctx.tempRoot,
            timeoutMs: 60_000,
          });
        }
      }
    }
  },
};
