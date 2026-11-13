import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type {
  Project,
  Workload,
} from "../../../packages/config-compiler/generated/native-config.ts";
import { isRecord } from "../../../src/lib/guards.ts";
import { openNativeComposeGenerationStore } from "../../../src/lib/native-compose-generation.ts";
import { createMonorepoFixture } from "../fixture.ts";
import {
  expect,
  expectExit,
  resolveCliSpawnArgs,
  runCommand,
  type Scenario,
} from "../harness.ts";
import { runWithOwnedCleanup } from "../native-compose-owned-fixture.ts";

const ID = /^[a-f0-9]{64}$/;
const SERVICES = ["first", "second", "third", "retry"];
const IDLE =
  'process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000);';
const RETRY = `const f=Bun.file("/tmp/attempt");const n=await f.exists()?Number(await f.text()):0;await Bun.write(f,String(n+1));if(n<2)process.exit(17);${IDLE}`;

function verifyContainer(opts: {
  readonly row: unknown;
  readonly owner: {
    readonly composeProject: string;
    readonly ownerToken: string;
  };
  readonly observed: Set<string>;
  readonly previous: Map<string, string>;
}): void {
  const row = opts.row;
  if (
    !(
      isRecord(row) &&
      typeof row.id === "string" &&
      typeof row.service === "string"
    )
  ) {
    throw new Error("Malformed fixture observation");
  }
  expect({
    that:
      row.project === opts.owner.composeProject &&
      row.owner === opts.owner.ownerToken &&
      row.instance === opts.owner.composeProject &&
      SERVICES.includes(row.service) &&
      !opts.observed.has(row.service),
    message: "Every selected container must belong to the exact fixture",
  });
  opts.observed.add(row.service);
  expect({
    that:
      row.running === true &&
      opts.previous.get(row.service) !== row.id &&
      row.restartCount === (row.service === "retry" ? 2 : 0),
    message:
      "Each iteration must recreate all containers and observe exactly two retry failures",
  });
  opts.previous.set(row.service, row.id);
}

/** Fifty fresh --profile starts exercise attachment without repeating unrelated grace/storage checks. */
export const nativeComposeEndpointSettlementScenario: Scenario = {
  name: "native-compose-endpoint-settlement",
  tier: "docker",
  summary:
    "50 fresh profile starts with an on-failure endpoint and strict ownership",
  preserveFixtureOnFailure: true,
  run: async (ctx) => {
    expect({
      that: resolveCliSpawnArgs([]).length === 1,
      message:
        "Endpoint acceptance requires the current compiled CLI and companion compiler",
    });
    const repeats = Number(process.env.HACK_E2E_ENDPOINT_SETTLE_RUNS ?? "50");
    expect({
      that: Number.isInteger(repeats) && repeats >= 1 && repeats <= 50,
      message: "Endpoint repetitions must be between 1 and 50",
    });
    const docker = async (args: readonly string[]) => {
      const result = await runCommand({
        argv: ["docker", ...args],
        cwd: ctx.tempRoot,
        timeoutMs: 30_000,
      });
      expectExit({ result, codes: [0], message: `Fixture Docker ${args[0]}` });
      return result.stdout.trim();
    };
    const image = await docker([
      "image",
      "inspect",
      "oven/bun:1.4.4-slim",
      "--format",
      "{{.Id}}",
    ]);
    expect({
      that: /^sha256:[a-f0-9]{64}$/.test(image),
      message: "The exact Bun image must already be cached; no pulls",
    });
    const fixture = await createMonorepoFixture({
      parentDir: ctx.tempRoot,
      withHackConfig: false,
    });
    const root = await realpath(fixture.root);
    await mkdir(join(root, ".hack"), { mode: 0o700 });
    const service = (name: string): Workload => ({
      image,
      pull_policy: "never",
      init: true,
      profiles: ["exercise"],
      command: { exec: ["bun", "-e", name === "retry" ? RETRY : IDLE] },
      restart:
        name === "retry"
          ? { kind: "on-failure", max_retries: 2 }
          : { kind: "no" },
      shutdown: { signal: "SIGTERM", grace: "1s" },
      ...(name === "retry"
        ? ({
            readiness: {
              kind: "exec",
              command: {
                exec: [
                  "bun",
                  "-e",
                  'process.exit(Number(await Bun.file("/tmp/attempt").text())===3?0:1)',
                ],
              },
              interval: "1s",
              timeout: "3s",
              retries: 10,
            },
          } as const)
        : {}),
    });
    const project: Project = {
      schema_version: 1,
      name: fixture.name,
      profiles: ["exercise"],
      services: Object.fromEntries(
        SERVICES.map((name) => [name, service(name)])
      ),
    };
    await Bun.write(
      join(root, ".hack/hack.project.json"),
      JSON.stringify(project)
    );
    const cli = (args: readonly string[]) =>
      ctx.cli({
        args,
        cwd: root,
        timeoutMs: 60_000,
        env: {
          HACK_RUNTIME_BACKEND: "compose",
          HACK_DAEMON_DISABLE_DOCKER_EVENTS: "1",
          HACK_COMPOSE_STARTUP_TIMEOUT_MS: "15000",
        },
      });
    const validation = await cli(["config", "validate", "--json"]);
    expectExit({
      result: validation,
      codes: [0],
      message: "Endpoint fixture must compile before engine execution",
    });
    let identity: { composeProject: string; ownerToken: string } | null = null;
    const previous = new Map<string, string>();
    let needsStop = false;
    const cleanup = async () => {
      if (!needsStop) {
        return;
      }
      const down = await cli(["down", "--json"]);
      expectExit({
        result: down,
        codes: [0],
        message: "Exact owned profile fixture down",
      });
      if (identity) {
        for (const kind of ["container", "network"] as const) {
          const args =
            kind === "container" ? ["ps", "-aq"] : ["network", "ls", "-q"];
          expect({
            that:
              (
                await docker([
                  ...args,
                  "--filter",
                  `label=com.docker.compose.project=${identity.composeProject}`,
                ])
              ).length === 0,
            message: "Profile cleanup must leave no selected resources",
          });
        }
      }
      needsStop = false;
    };
    await runWithOwnedCleanup({
      run: async () => {
        for (let iteration = 1; iteration <= repeats; iteration++) {
          needsStop = true;
          const up = await cli([
            "--profile",
            "exercise",
            "up",
            "--detach",
            "--json",
          ]);
          expectExit({
            result: up,
            codes: [0],
            message: `Profile startup ${iteration}/${repeats}`,
          });
          const store = await openNativeComposeGenerationStore({
            projectRoot: root,
            instance: null,
            mode: "saved",
          });
          try {
            const state = await store.loadCurrent();
            expect({
              that: state.pending === null && !state.stopped,
              message: "Each profile start must commit a ready generation",
            });
            const current = {
              composeProject: store.identity.composeProject,
              ownerToken: store.identity.ownerToken,
            };
            expect({
              that:
                identity === null ||
                JSON.stringify(identity) === JSON.stringify(current),
              message: "Repeated starts must preserve the fixture owner",
            });
            identity = current;
          } finally {
            await store.close();
          }
          const owner = identity;
          if (!owner) {
            throw new Error("Missing verified fixture identity");
          }
          const ids = (
            await docker([
              "ps",
              "-aq",
              "--no-trunc",
              "--filter",
              `label=com.docker.compose.project=${owner.composeProject}`,
            ])
          )
            .split(/\s+/)
            .filter(Boolean);
          expect({
            that: ids.length === 4 && ids.every((id) => ID.test(id)),
            message: "Exactly four full container IDs must be selected",
          });
          const rows = (
            await docker([
              "inspect",
              ...ids,
              "--format",
              '{"id":{{json .Id}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"owner":{{json (index .Config.Labels "io.hack.native-config.owner")}},"instance":{{json (index .Config.Labels "io.hack.native-config.instance")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"running":{{json .State.Running}},"restartCount":{{json .RestartCount}}}',
            ])
          ).split("\n");
          const observed = new Set<string>();
          for (const text of rows) {
            verifyContainer({
              row: JSON.parse(text),
              owner,
              observed,
              previous,
            });
          }
          await cleanup();
          ctx.log(
            `fresh profile start ${iteration}/${repeats}: four new containers, two failure retries, clean down`
          );
        }
      },
      cleanup,
      secondaryFailure: () =>
        ctx.retainFixtures("Owned profile cleanup remains uncertain"),
    });
  },
};
