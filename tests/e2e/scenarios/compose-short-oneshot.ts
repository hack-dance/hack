import { join } from "node:path";
import { createMonorepoFixture } from "../fixture.ts";
import { expect, expectExit, runCommand, type Scenario } from "../harness.ts";

/** Real, unlabelled restart:no job; config drift replaces its old exited container. */
export const composeShortOneshotScenario: Scenario = {
  name: "compose-short-oneshot",
  tier: "docker",
  summary: "sub-second depends_on initializer survives repeated detached up",
  run: async (ctx) => {
    const repeats = Number(process.env.HACK_E2E_COMPOSE_ONESHOT_RUNS ?? "3");
    expect({
      that: Number.isInteger(repeats) && repeats >= 1 && repeats <= 50,
      message: "One-shot repetitions must be between 1 and 50",
    });
    const fixture = await createMonorepoFixture({
      parentDir: ctx.tempRoot,
      withHackConfig: true,
      lifecycle: { disableInternal: true },
    });
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
        timeoutMs: 120_000,
        env: { HACK_RUNTIME_BACKEND: "compose", HACK_EXECUTION_MODE: "slim" },
      });
    const image = "alpine:3.20";
    // Admission and cleanup are owned by the repository's isolated Docker harness.
    await docker(["image", "inspect", image, "--format", "{{.Id}}"]);
    let previousId = "";
    try {
      for (let run = 1; run <= repeats; run++) {
        await Bun.write(
          join(fixture.hackDir, "docker-compose.yml"),
          JSON.stringify({
            name: fixture.name,
            services: {
              server: {
                image,
                pull_policy: "never",
                command: [
                  "sh",
                  "-c",
                  "while :; do printf 'HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\n\\r\\nok' | nc -l -p 8080; done",
                ],
              },
              init: {
                image,
                pull_policy: "never",
                restart: "no",
                depends_on: ["server"],
                environment: { ITERATION: String(run) },
                command: [
                  "sh",
                  "-c",
                  "until wget -qO /dev/null http://server:8080; do sleep 0.05; done; sleep 0.05",
                ],
              },
            },
            networks: { default: { internal: true } },
          })
        );
        const up = await cli(["up", "-d"]);
        if (up.exitCode !== 0) {
          ctx.log(
            await docker([
              "compose",
              "-p",
              fixture.name,
              "-f",
              join(fixture.hackDir, "docker-compose.yml"),
              "logs",
              "--no-color",
            ])
          );
        }
        expectExit({
          result: up,
          codes: [0],
          message: `Detached up ${run}/${repeats}`,
        });
        const id = await docker([
          "ps",
          "-aq",
          "--filter",
          `label=com.docker.compose.project=${fixture.name}`,
          "--filter",
          "label=com.docker.compose.service=init",
        ]);
        expect({
          that: /^[a-f0-9]{64}$/.test(id) || /^[a-f0-9]{12}$/.test(id),
          message: "Exactly one initializer must exist",
        });
        expect({
          that: id !== previousId,
          message: "Each up must replace the previous initializer",
        });
        previousId = id;
        // Independent readback proves an actual start and exit, not Created/ExitCode=0.
        await docker(["wait", id]);
        const state: unknown = JSON.parse(
          await docker(["inspect", id, "--format", "{{json .State}}"])
        );
        if (
          typeof state !== "object" ||
          state === null ||
          !("StartedAt" in state) ||
          !("FinishedAt" in state) ||
          !("ExitCode" in state) ||
          !("Status" in state)
        ) {
          throw new Error("Missing initializer state");
        }
        const duration =
          Date.parse(String(state.FinishedAt)) -
          Date.parse(String(state.StartedAt));
        expect({
          that:
            state.Status === "exited" &&
            state.ExitCode === 0 &&
            duration > 0 &&
            duration < 1000,
          message: "Initializer must really exit zero in under one second",
        });
        ctx.log(
          `detached up ${run}/${repeats}: initializer exited 0 in ${duration} ms`
        );
      }
    } finally {
      const down = await cli(["down"]);
      expectExit({ result: down, codes: [0], message: "Owned fixture down" });
    }
  },
};
