import { join } from "node:path";
import { createMonorepoFixture } from "../fixture.ts";
import {
  type CliResult,
  expect,
  expectExit,
  runCommand,
  type Scenario,
} from "../harness.ts";

const OWNER = "hack.e2e.compose-config-hash-drift-owner";
const PROJECT = "com.docker.compose.project";
const SERVICE = "com.docker.compose.service";
const ONEOFF = "com.docker.compose.oneoff";
const CONFIG_HASH = "com.docker.compose.config-hash";
const TIMEOUT = 180_000;
const IMAGE = "alpine:3.20";
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const SERVICES = ["app", "dep"] as const;
const BEFORE = "before";
const AFTER = "after";
// Exits promptly on SIGTERM so `hack down` does not wait for the grace period.
const IDLE = ["sh", "-c", "trap 'exit 0' TERM; while :; do sleep 1; done"];

type ServiceName = (typeof SERVICES)[number];

/** Identity of one long-running (non-one-off) Compose service container. */
type ContainerIdentity = {
  readonly id: string;
  readonly startedAt: string;
  readonly restartCount: string;
  readonly running: string;
  readonly configHash: string;
};

type Snapshot = Readonly<Record<ServiceName, ContainerIdentity>>;

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected an object from Docker inspect");
  }
  return value as Record<string, unknown>;
}

function composeDocument(opts: {
  readonly name: string;
  readonly image: string;
  readonly marker: string;
}): string {
  const labels = { [OWNER]: opts.name };
  const service = {
    image: opts.image,
    pull_policy: "never",
    labels,
    command: IDLE,
  };
  return JSON.stringify({
    name: opts.name,
    services: {
      app: {
        ...service,
        environment: { DRIFT_ROLE: "target" },
        depends_on: { dep: { condition: "service_started" } },
      },
      // Only this service's config changes between the two documents.
      dep: { ...service, environment: { DRIFT_MARKER: opts.marker } },
    },
    networks: { default: { internal: true, labels } },
  });
}

function sameIdentity(a: ContainerIdentity, b: ContainerIdentity): boolean {
  return (
    a.id === b.id &&
    a.startedAt === b.startedAt &&
    a.restartCount === b.restartCount &&
    a.configHash === b.configHash &&
    b.running === "true"
  );
}

/**
 * F03 / HACK-1124 reproduction: Compose config-hash drift on a dependency must
 * not let `hack run` or `hack exec` recreate or restart any running container.
 *
 * `hack run` has no user `--no-deps` flag; the legacy Compose path adds
 * `--no-deps` itself when the target service is already running
 * (`resolveCanSkipRunDependencies`), and `hack exec` maps to
 * `docker compose exec`, which never converges services. Without `--no-deps`,
 * `docker compose run` would start dependencies and recreate one whose config
 * hash diverged. The scenario therefore:
 *
 * 1. starts `app` (depends on `dep`) and records each container's full ID,
 *    `State.StartedAt`, `RestartCount` and config-hash label;
 * 2. changes only `dep`'s environment, so only `dep`'s config hash drifts;
 * 3. runs `hack run app`, `hack run dep`, `hack exec app` and `hack exec dep`
 *    and requires identical identities after each, no leftover one-off
 *    containers, and that the running `dep` still has the pre-drift value;
 * 4. positive controls: the `hack run dep` one-off must see the drifted value
 *    (so Compose received the drifted config through Hack's real file set),
 *    and a final `hack up --detach` must recreate `dep` (so the identity
 *    comparison detects recreation instead of passing vacuously).
 */
export const composeConfigHashDriftScenario: Scenario = {
  name: "compose-config-hash-drift",
  tier: "docker",
  summary:
    "dependency config-hash drift: hack run/exec keep running containers (F03)",
  run: async (ctx) => {
    const docker = async (args: readonly string[]) => {
      const result = await runCommand({
        argv: ["docker", ...args],
        cwd: ctx.tempRoot,
        timeoutMs: TIMEOUT,
      });
      expectExit({
        result,
        codes: [0],
        message: `Docker ${args[0]} must succeed`,
      });
      return result.stdout.trim();
    };
    expect({
      that: (await docker(["info", "--format", "{{.OSType}}"])) === "linux",
      message: "A Linux Docker daemon is required",
    });
    await docker(["compose", "version"]);
    const image = await docker([
      "image",
      "inspect",
      IMAGE,
      "--format",
      "{{.Id}}",
    ]);
    expect({
      that: IMAGE_ID.test(image),
      message: `${IMAGE} must already be cached with an immutable ID`,
    });

    const fixture = await createMonorepoFixture({
      parentDir: ctx.tempRoot,
      withHackConfig: true,
      lifecycle: { disableInternal: true },
    });
    const name = fixture.name;
    const composePath = join(fixture.hackDir, "docker-compose.yml");
    await Bun.write(
      join(fixture.hackDir, "hack.config.json"),
      JSON.stringify({
        name,
        internal: { dns: false, tls: false },
        logs: {
          follow_backend: "compose",
          snapshot_backend: "compose",
          clear_on_down: false,
        },
      })
    );
    await Bun.write(
      composePath,
      composeDocument({ name, image, marker: BEFORE })
    );

    const cli = async (args: readonly string[]): Promise<CliResult> => {
      const result = await ctx.cli({
        args,
        cwd: fixture.root,
        timeoutMs: TIMEOUT,
        env: {
          HACK_EXECUTION_MODE: "slim",
          HACK_DAEMON_DISABLE_DOCKER_EVENTS: "1",
        },
      });
      expectExit({
        result,
        codes: [0],
        message: `hack ${args[0]} must succeed`,
      });
      return result;
    };
    const list = async (
      kind: "container" | "network" | "volume",
      filters: readonly string[]
    ) => {
      const args = kind === "container" ? ["ps", "-aq"] : [kind, "ls", "-q"];
      return (
        await docker([
          ...args,
          "--filter",
          `label=${OWNER}=${name}`,
          ...filters.flatMap((filter) => ["--filter", `label=${filter}`]),
        ])
      )
        .split(/\s+/)
        .filter(Boolean);
    };
    const owned = async (
      kind: "container" | "network" | "volume",
      id: string
    ) => {
      const expression =
        kind === "container" ? "{{json .Config.Labels}}" : "{{json .Labels}}";
      const actual = object(
        JSON.parse(await docker([kind, "inspect", id, "--format", expression]))
      );
      expect({
        that: actual[OWNER] === name && actual[PROJECT] === name,
        message: `Refuse ${kind} mutation outside exact fixture ownership`,
      });
    };
    const clean = async () => {
      for (const kind of ["container", "network", "volume"] as const) {
        for (const id of await list(kind, [])) {
          await owned(kind, id);
          await docker([
            kind,
            "rm",
            ...(kind === "container" ? ["--force"] : []),
            id,
          ]);
        }
        expect({
          that: (await list(kind, [])).length === 0,
          message: `Owned ${kind} cleanup must leave no resources`,
        });
      }
    };
    const identity = async (service: ServiceName) => {
      const ids = await list("container", [
        `${SERVICE}=${service}`,
        `${ONEOFF}=False`,
      ]);
      const id = ids[0];
      if (ids.length !== 1 || !id) {
        throw new Error(`Expected exactly one owned ${service} container`);
      }
      await owned("container", id);
      const fields = object(
        JSON.parse(
          await docker([
            "inspect",
            id,
            "--format",
            `{"id":{{json .Id}},"startedAt":{{json .State.StartedAt}},"restartCount":"{{.RestartCount}}","running":"{{.State.Running}}","configHash":{{json (index .Config.Labels "${CONFIG_HASH}")}}}`,
          ])
        )
      );
      const value = {
        id: String(fields.id),
        startedAt: String(fields.startedAt),
        restartCount: String(fields.restartCount),
        running: String(fields.running),
        configHash: String(fields.configHash),
      };
      expect({
        that:
          CONTAINER_ID.test(value.id) &&
          value.startedAt.length > 0 &&
          /^[a-f0-9]{64}$/.test(value.configHash),
        message: `${service} must expose a full ID, start time and config hash`,
      });
      return value;
    };
    const snapshot = async (): Promise<Snapshot> => ({
      app: await identity("app"),
      dep: await identity("dep"),
    });
    const record = (label: string, value: Snapshot) => {
      for (const service of SERVICES) {
        const entry = value[service];
        ctx.log(
          `${label} ${service}: id=${entry.id.slice(0, 12)} startedAt=${entry.startedAt} restarts=${entry.restartCount} running=${entry.running} hash=${entry.configHash.slice(0, 12)}`
        );
      }
    };
    const requireUnchanged = async (opts: {
      readonly step: string;
      readonly baseline: Snapshot;
    }) => {
      const current = await snapshot();
      record(opts.step, current);
      for (const service of SERVICES) {
        expect({
          that: sameIdentity(opts.baseline[service], current[service]),
          message: `${opts.step} must not recreate or restart ${service}`,
        });
      }
      expect({
        that: (await list("container", [`${ONEOFF}=True`])).length === 0,
        message: `${opts.step} must not leave a one-off container behind`,
      });
    };
    const printed = (result: CliResult, value: string, step: string) => {
      expect({
        that: result.stdout.trim() === value,
        message: `${step} must print the expected marker`,
        result,
      });
    };

    try {
      await cli(["up", "--detach"]);
      const baseline = await snapshot();
      record("up", baseline);
      expect({
        that: SERVICES.every((service) => baseline[service].running === "true"),
        message: "Both services must run after hack up --detach",
      });

      // Drift only the dependency's config hash; the target stays identical.
      await Bun.write(
        composePath,
        composeDocument({ name, image, marker: AFTER })
      );

      const runApp = await cli([
        "run",
        "app",
        "--",
        "sh",
        "-c",
        "printf run-ok",
      ]);
      printed(runApp, "run-ok", "hack run app");
      await requireUnchanged({ step: "hack run app", baseline });

      // Positive control: the one-off sees the drifted dependency config, so
      // Compose received the changed document through Hack's file set.
      const runDep = await cli([
        "run",
        "dep",
        "--",
        "sh",
        "-c",
        'printf %s "$DRIFT_MARKER"',
      ]);
      printed(runDep, AFTER, "hack run dep");
      await requireUnchanged({ step: "hack run dep", baseline });

      const execApp = await cli([
        "exec",
        "app",
        "--",
        "sh",
        "-c",
        "printf exec-ok",
      ]);
      printed(execApp, "exec-ok", "hack exec app");
      await requireUnchanged({ step: "hack exec app", baseline });

      // The running dependency must still be the pre-drift container.
      const execDep = await cli([
        "exec",
        "dep",
        "--",
        "sh",
        "-c",
        'printf %s "$DRIFT_MARKER"',
      ]);
      printed(execDep, BEFORE, "hack exec dep");
      await requireUnchanged({ step: "hack exec dep", baseline });

      // Positive control: converging the stack does recreate the drifted
      // dependency, so the identity comparison above can observe recreation.
      await cli(["up", "--detach"]);
      const converged = await snapshot();
      record("converged up", converged);
      expect({
        that:
          converged.dep.id !== baseline.dep.id &&
          converged.dep.configHash !== baseline.dep.configHash &&
          converged.dep.running === "true",
        message:
          "hack up --detach must recreate the drifted dependency (positive control)",
      });
      ctx.log(
        `converged up target: ${sameIdentity(baseline.app, converged.app) ? "retained" : "recreated or restarted"} (observed only)`
      );
      const convergedDep = await cli([
        "exec",
        "dep",
        "--",
        "sh",
        "-c",
        'printf %s "$DRIFT_MARKER"',
      ]);
      printed(convergedDep, AFTER, "hack exec dep after converge");

      await cli(["down"]);
      expect({
        that: (await list("container", [])).length === 0,
        message: "hack down must remove all fixture containers",
      });
      ctx.log(
        "dependency config-hash drift: hack run/exec retained every container ID, start time and restart count"
      );
    } finally {
      await clean();
    }
  },
};
