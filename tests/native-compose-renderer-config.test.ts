import { expect, test } from "bun:test";
import { isRecord } from "../src/lib/guards.ts";
import { renderNativeCompose } from "../src/lib/native-compose-renderer.ts";
import { composeFixture } from "./helpers/native-compose.ts";

const configTest =
  process.env.HACK_TEST_COMPOSE_CONFIG === "1" ? test : test.skip;

/** Uses configuration normalization only: no daemon connection, container start, pull or build. */
async function normalized(opts: {
  readonly json: string;
  readonly profiles?: readonly string[];
}): Promise<Record<string, unknown>> {
  const args = ["docker", "compose", "-f", "-"];
  for (const profile of opts.profiles ?? []) {
    args.push("--profile", profile);
  }
  args.push("config", "--format", "json");
  const child = Bun.spawn(args, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      AMBIENT: "hostile-interpolation-value",
      READY: "hostile-interpolation-value",
      COMPOSE_PROFILES: "unselected-profile",
    },
  });
  child.stdin.write(opts.json);
  child.stdin.end();
  const timer = setTimeout(() => child.kill(), 15_000);
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).not.toContain("hostile-interpolation-value");
    expect(exit).toBe(0);
    const result: unknown = JSON.parse(stdout);
    if (!isRecord(result)) {
      throw new Error("Compose config did not produce an object");
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

configTest(
  "actual Compose normalization preserves dollars, empty args and explicit shell healthcheck",
  async () => {
    const input = composeFixture({
      services: {
        web: {
          image: "fixture/web:1",
          command: { exec: ["server", "${AMBIENT}", "$", "$$", ""] },
          entrypoint: { exec: [] },
          init: false,
          shutdown: { signal: "SIGTERM", grace: "45000ms" },
          restart: { kind: "on-failure", max_retries: 3 },
          readiness: {
            kind: "exec",
            command: { shell: 'test -n "$READY"' },
            interval: "1000ms",
            timeout: "1000ms",
            retries: 3,
          },
          environment: {
            LITERAL: { literal: "${AMBIENT:-wrong}" },
            NUMBER: { literal: "false" },
            EMPTY: { literal: "" },
          },
        },
      },
    });
    input.environmentPlan.workloads.web = {
      LITERAL: { kind: "literal", value: "${AMBIENT:-wrong}" },
      NUMBER: { kind: "literal", value: "false" },
      EMPTY: { kind: "literal", value: "" },
    };
    const result = await normalized(renderNativeCompose(input));
    expect(result).toMatchObject({
      name: "nc03-fixture-a",
      services: {
        web: {
          command: ["server", "$${AMBIENT}", "$$", "$$$$", ""],
          entrypoint: [],
          init: false,
          restart: "on-failure:3",
          stop_signal: "SIGTERM",
          stop_grace_period: "45s",
          environment: {
            LITERAL: "$${AMBIENT:-wrong}",
            NUMBER: "false",
            EMPTY: "",
          },
          healthcheck: {
            test: ["CMD", "/bin/sh", "-c", 'test -n "$$READY"'],
            interval: "1s",
            timeout: "1s",
            retries: 3,
          },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("hostile-interpolation-value");
  }
);

configTest(
  "actual Compose normalization keeps profiles, dependency conditions and owned persistent names",
  async () => {
    const input = composeFixture({
      services: {
        web: {
          image: "fixture/web:1",
          profiles: ["dev"],
          depends_on: [
            { service: "db", condition: "ready" },
            { job: "setup", condition: "completed" },
          ],
          mounts: [
            { source: ".", target: "/app", access: "read-only" },
            { storage: "data", target: "/data", access: "read-write" },
          ],
        },
        db: {
          image: "fixture/db:1",
          readiness: {
            kind: "exec",
            command: { exec: ["db-ready"] },
            interval: "2000ms",
            timeout: "1000ms",
            retries: 3,
          },
        },
      },
      jobs: {
        setup: {
          build: { context: "backend", dockerfile: "Dockerfile" },
          command: { exec: ["setup"] },
        },
      },
    });
    input.plan.selected_profiles = ["dev"];
    input.plan.storage.data = { kind: "persistent", scope: "worktree" };
    const result = await normalized(renderNativeCompose(input));
    expect(result).toMatchObject({
      name: "nc03-fixture-a",
      services: {
        web: {
          profiles: ["dev"],
          labels: {
            "io.hack.native-config.owner": "c".repeat(32),
            "io.hack.native-config.workload": "service",
          },
          depends_on: {
            db: { condition: "service_healthy" },
            setup: { condition: "service_completed_successfully" },
          },
          volumes: [
            {
              type: "bind",
              source: "/verified/checkout",
              target: "/app",
              read_only: true,
              bind: { create_host_path: false },
            },
            { type: "volume", source: "data", target: "/data" },
          ],
        },
        setup: {
          labels: {
            "io.hack.native-config.owner": "c".repeat(32),
            "io.hack.native-config.workload": "job",
          },
          build: {
            context: "/verified/checkout/backend",
            dockerfile: "Dockerfile",
          },
        },
      },
      volumes: {
        data: {
          name: "hack-14-nc03-fixture-a-4-data",
          labels: { "io.hack.native-config.owner": "c".repeat(32) },
        },
      },
      networks: {
        default: {
          name: "nc03-fixture-a_default",
          labels: { "io.hack.native-config.owner": "c".repeat(32) },
        },
      },
    });
  }
);

configTest(
  "normalization negative control expands an unescaped host interpolation",
  async () => {
    const result = await normalized({
      json: JSON.stringify({
        name: "nc03-negative-control",
        services: {
          web: {
            image: "fixture/web:1",
            command: ["server", "${AMBIENT}"],
            environment: { LITERAL: "${AMBIENT}" },
          },
        },
      }),
    });
    expect(result).toMatchObject({
      services: {
        web: {
          command: ["server", "hostile-interpolation-value"],
          environment: { LITERAL: "hostile-interpolation-value" },
        },
      },
    });
  }
);

configTest(
  "dollar-bearing checkout paths remain literal in normalized bind and build sources",
  async () => {
    const input = composeFixture({
      services: {
        web: {
          image: "fixture/web:1",
          mounts: [{ source: "src", target: "/app", access: "read-only" }],
        },
      },
      jobs: {
        buildcheck: {
          build: { context: "backend", dockerfile: "Dockerfile" },
          command: { exec: ["check"] },
        },
      },
    });
    input.projectRoot = "/verified/${AMBIENT}/checkout";
    const result = await normalized(renderNativeCompose(input));
    expect(result).toMatchObject({
      services: {
        web: { volumes: [{ source: "/verified/$${AMBIENT}/checkout/src" }] },
        buildcheck: {
          build: { context: "/verified/$${AMBIENT}/checkout/backend" },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("hostile-interpolation-value");
  }
);

configTest(
  "actual Compose normalization preserves canonical pull/build policy intent",
  async () => {
    const input = composeFixture({
      services: {
        always: { image: "fixture/always:1", pull_policy: "always" },
        never: { image: "fixture/never:1", pull_policy: "never" },
        missing: { image: "fixture/missing:latest", pull_policy: "missing" },
        builder: {
          build: { context: ".", dockerfile: "Dockerfile" },
          pull_policy: "build",
        },
      },
    });
    const result = await normalized(renderNativeCompose(input));
    expect(result).toMatchObject({
      services: {
        always: { pull_policy: "always" },
        never: { pull_policy: "never" },
        missing: { image: "fixture/missing:latest", pull_policy: "missing" },
        builder: { pull_policy: "build" },
      },
    });
  }
);
