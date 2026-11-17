import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composeOneShotGraph,
  effectiveComposeProfiles,
  interpolateComposeValue,
  mergeOneShotGraphs,
  readComposeOneShotGraph,
  runningOneShots,
  scopeOneShotGraph,
  startWatchDecision,
  waitingDependents,
} from "../src/lib/compose-oneshot-progress.ts";
import {
  composeStartupFailure,
  DEFAULT_COMPOSE_STARTUP_CEILING_MS,
  resolveComposeStartupCeilingMs,
  resolveComposeStartupTimeoutMs,
} from "../src/lib/compose-startup-budget.ts";

/* HACK-2310: a running one-shot dependency is start progress, not a hang. */

const DOCUMENT = {
  services: {
    db: { image: "db" },
    migrate: {
      image: "app",
      depends_on: { db: { condition: "service_healthy" } },
    },
    api: {
      image: "app",
      depends_on: {
        migrate: { condition: "service_completed_successfully" },
        db: { condition: "service_healthy" },
      },
    },
    worker: {
      image: "app",
      depends_on: {
        migrate: { condition: "service_completed_successfully" },
      },
    },
    web: { image: "web", depends_on: ["api"] },
  },
};

const entry = (Service: string, State: string) => ({ Service, State });

test("one-shots are the targets of service_completed_successfully only", () => {
  const graph = composeOneShotGraph(DOCUMENT);
  expect([...graph.oneShots]).toEqual(["migrate"]);
  expect(Object.fromEntries(graph.waitsOn)).toEqual({
    api: ["migrate"],
    worker: ["migrate"],
  });
  expect(composeOneShotGraph({}).oneShots.size).toBe(0);
  expect(composeOneShotGraph("not a document").oneShots.size).toBe(0);
});

test("an override's one-shot edges add to the base file's", () => {
  const graph = mergeOneShotGraphs([
    DOCUMENT,
    {
      services: {
        api: {
          depends_on: {
            seed: { condition: "service_completed_successfully" },
          },
        },
      },
    },
  ]);
  expect([...graph.oneShots].sort()).toEqual(["migrate", "seed"]);
  expect(graph.waitsOn.get("api")).toEqual(["migrate", "seed"]);
});

test("an override that changes the condition removes the one-shot edge", () => {
  const graph = mergeOneShotGraphs([
    DOCUMENT,
    {
      services: {
        api: { depends_on: { migrate: { condition: "service_started" } } },
        worker: { depends_on: ["migrate"] },
      },
    },
  ]);
  expect(graph.oneShots.size).toBe(0);
  expect(graph.waitsOn.size).toBe(0);
  // Changing only one of the two dependents keeps the other edge.
  const partial = mergeOneShotGraphs([
    DOCUMENT,
    {
      services: {
        api: { depends_on: { migrate: { condition: "service_started" } } },
      },
    },
  ]);
  expect([...partial.oneShots]).toEqual(["migrate"]);
  expect(Object.fromEntries(partial.waitsOn)).toEqual({ worker: ["migrate"] });
});

test("a dependent its profiles leave out makes nothing a one-shot", () => {
  const document = {
    services: {
      api: { image: "app" },
      report: {
        image: "app",
        profiles: ["benchmark"],
        depends_on: {
          api: { condition: "service_completed_successfully" },
        },
      },
    },
  };
  expect([
    ...composeOneShotGraph(document, { activeProfiles: [] }).oneShots,
  ]).toEqual([]);
  expect([
    ...composeOneShotGraph(document, { activeProfiles: ["benchmark"] })
      .oneShots,
  ]).toEqual(["api"]);
  // Compose's `*` enables every profile, from --profile or COMPOSE_PROFILES.
  for (const env of [{}, { COMPOSE_PROFILES: "*" }]) {
    const activeProfiles = effectiveComposeProfiles({
      cliProfiles: Object.keys(env).length === 0 ? ["*"] : [],
      env,
    });
    expect([
      ...composeOneShotGraph(document, { activeProfiles }).oneShots,
    ]).toEqual(["api"]);
  }
  // Without known profiles every service counts, as before.
  expect([...composeOneShotGraph(document).oneShots]).toEqual(["api"]);
});

test("profiles come from --profile, else the delivered COMPOSE_PROFILES", () => {
  expect(
    effectiveComposeProfiles({
      cliProfiles: ["ops"],
      env: { COMPOSE_PROFILES: "benchmark" },
    })
  ).toEqual(["ops"]);
  expect(
    effectiveComposeProfiles({
      cliProfiles: [],
      env: { COMPOSE_PROFILES: " benchmark, ops ,," },
    })
  ).toEqual(["benchmark", "ops"]);
  expect(
    effectiveComposeProfiles({ cliProfiles: [], env: { COMPOSE_PROFILES: "" } })
  ).toEqual([]);
});

test("only a running one-shot is progress; a restarting one is not", () => {
  const graph = composeOneShotGraph(DOCUMENT);
  expect(
    runningOneShots({
      graph,
      entries: [entry("migrate", "running"), entry("db", "running")],
    })
  ).toEqual(["migrate"]);
  expect(
    runningOneShots({ graph, entries: [entry("migrate", "restarting")] })
  ).toEqual([]);
  expect(
    runningOneShots({ graph, entries: [entry("migrate", "exited")] })
  ).toEqual([]);
});

test("Created dependents of a running one-shot are waiting for it", () => {
  const graph = composeOneShotGraph(DOCUMENT);
  expect(
    waitingDependents({
      graph,
      entries: [
        entry("migrate", "running"),
        entry("api", "created"),
        entry("worker", "running"),
        entry("web", "created"),
      ],
    })
  ).toEqual({ api: ["migrate"] });
  // Once the one-shot exited, nothing is waiting for it.
  expect(
    waitingDependents({
      graph,
      entries: [entry("migrate", "exited"), entry("api", "created")],
    })
  ).toEqual({});
});

test("the watchdog waits while progress is recent and stops at idle or the ceiling", () => {
  const base = { startedAt: 0, idleBudgetMs: 90_000, ceilingMs: 1_800_000 };
  // No progress at all: the old wall-clock budget.
  expect(startWatchDecision({ ...base, now: 89_999, lastProgressAt: 0 })).toBe(
    "wait"
  );
  expect(startWatchDecision({ ...base, now: 90_000, lastProgressAt: 0 })).toBe(
    "idle"
  );
  // A one-shot seen running 30 s ago keeps a 3-minute start going.
  expect(
    startWatchDecision({ ...base, now: 180_000, lastProgressAt: 150_000 })
  ).toBe("wait");
  // Progress never outlasts the absolute ceiling.
  expect(
    startWatchDecision({
      ...base,
      now: 1_800_000,
      lastProgressAt: 1_799_000,
    })
  ).toBe("ceiling");
});

test("the host variable wins over the project setting, which wins over the default", () => {
  expect(resolveComposeStartupTimeoutMs({ env: {} })).toBe(90_000);
  expect(
    resolveComposeStartupTimeoutMs({ env: {}, projectValue: 240_000 })
  ).toBe(240_000);
  expect(
    resolveComposeStartupTimeoutMs({
      env: { HACK_COMPOSE_STARTUP_TIMEOUT_MS: "120000" },
      projectValue: 240_000,
    })
  ).toBe(120_000);
  expect(() =>
    resolveComposeStartupTimeoutMs({ env: {}, projectValue: Number.NaN })
  ).toThrow("compose.startupTimeoutMs");
  expect(() =>
    resolveComposeStartupTimeoutMs({ env: {}, projectValue: 10 })
  ).toThrow("compose.startupTimeoutMs");
});

test("the ceiling defaults to 30 minutes and is never below the budget", () => {
  expect(
    resolveComposeStartupCeilingMs({ startupTimeoutMs: 90_000, env: {} })
  ).toBe(DEFAULT_COMPOSE_STARTUP_CEILING_MS);
  expect(
    resolveComposeStartupCeilingMs({
      startupTimeoutMs: 90_000,
      env: {},
      projectValue: 600_000,
    })
  ).toBe(600_000);
  expect(
    resolveComposeStartupCeilingMs({
      startupTimeoutMs: 120_000,
      env: { HACK_COMPOSE_STARTUP_CEILING_MS: "60000" },
    })
  ).toBe(120_000);
});

test("a start cut short while a one-shot runs says the start is still in progress", () => {
  const failure = composeStartupFailure({
    code: 124,
    action: "docker compose up",
    phase: "start",
    budgets: {
      imageTimeoutMs: 1_800_000,
      startupTimeoutMs: 90_000,
      startupCeilingMs: 1_800_000,
    },
    inProgress: ["migrate"],
  });
  expect(failure.code).toBe("E_STARTUP_TIMEOUT");
  expect(failure.inProgress).toEqual(["migrate"]);
  expect(failure.budgetEnv).toBe("HACK_COMPOSE_STARTUP_CEILING_MS");
  expect(failure.message).toContain("the one-shot service migrate");
  expect(failure.message).toContain("the start is still in progress");
  expect(failure.message).toContain(
    "Running hack restart or hack down now would interrupt migrate"
  );
  expect(failure.message).toContain("run hack up -d again");
  // Without a running one-shot, the old message stands.
  const idle = composeStartupFailure({
    code: 124,
    action: "docker compose up",
    phase: "start",
    budgets: { imageTimeoutMs: 1_800_000, startupTimeoutMs: 90_000 },
    inProgress: [],
  });
  expect(idle.message).toContain("startup budget of 90000 ms");
  expect(idle.inProgress).toEqual([]);
});

test("a completion dependency inherited from an extension anchor counts", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-oneshot-merge-"));
  try {
    const file = join(root, "docker-compose.yml");
    await writeFile(
      file,
      [
        "x-app: &app",
        "  image: app",
        "  depends_on:",
        "    migrate:",
        "      condition: service_completed_successfully",
        "services:",
        "  migrate:",
        "    image: app",
        "  api:",
        "    <<: *app",
        "",
      ].join("\n")
    );
    const graph = await readComposeOneShotGraph([file]);
    expect([...graph.oneShots]).toEqual(["migrate"]);
    expect(Object.fromEntries(graph.waitsOn)).toEqual({ api: ["migrate"] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a service-scoped start waits only on the one-shots in its scope", () => {
  const graph = composeOneShotGraph({
    services: {
      migrate: { image: "app" },
      api: {
        image: "app",
        depends_on: {
          migrate: { condition: "service_completed_successfully" },
        },
      },
      edge: { image: "edge", depends_on: ["api"] },
      web: { image: "web" },
    },
  });
  // Unrelated to migrate: nothing to wait on.
  expect([...scopeOneShotGraph(graph, { services: ["web"] }).oneShots]).toEqual(
    []
  );
  // edge -> api -> migrate: Compose starts and waits through the chain.
  expect([
    ...scopeOneShotGraph(graph, { services: ["edge"] }).oneShots,
  ]).toEqual(["migrate"]);
  // --no-deps starts only the selection and waits for nothing.
  expect([
    ...scopeOneShotGraph(graph, { services: ["api"], noDeps: true }).oneShots,
  ]).toEqual([]);
  // No selection: the whole graph.
  expect([...scopeOneShotGraph(graph, {}).oneShots]).toEqual(["migrate"]);
});

test("profile values are interpolated as Compose does", () => {
  const env = { APP_PROFILE: "prod", EMPTY: "" };
  expect(interpolateComposeValue("${APP_PROFILE}", env)).toBe("prod");
  expect(interpolateComposeValue("$APP_PROFILE", env)).toBe("prod");
  expect(interpolateComposeValue("${MISSING:-dev}", env)).toBe("dev");
  expect(interpolateComposeValue("${EMPTY:-dev}", env)).toBe("dev");
  expect(interpolateComposeValue("${EMPTY-dev}", env)).toBe("");
  expect(interpolateComposeValue("$$literal", env)).toBe("$literal");
  expect(interpolateComposeValue("${MISSING:?required}", env)).toBeNull();
  expect(interpolateComposeValue("${X:-${Y}}", env)).toBeNull();
});

test("an interpolated profile decides whether its service counts", () => {
  const document = {
    services: {
      migrate: { image: "app" },
      api: {
        image: "app",
        profiles: ["${APP_PROFILE:-dev}"],
        depends_on: {
          migrate: { condition: "service_completed_successfully" },
        },
      },
    },
  };
  const graph = (
    doc: unknown,
    activeProfiles: string[],
    interpolationEnv: Record<string, string>
  ) => [
    ...composeOneShotGraph(doc, { activeProfiles, interpolationEnv }).oneShots,
  ];
  // The default applies: api is in profile dev.
  expect(graph(document, ["dev"], {})).toEqual(["migrate"]);
  // The variable selects another profile: api is off under dev.
  expect(graph(document, ["dev"], { APP_PROFILE: "prod" })).toEqual([]);
  // A form Hack cannot evaluate keeps the service: never cut a real wait short.
  const unknown = {
    services: {
      ...document.services,
      api: { ...document.services.api, profiles: ["${APP:?set it}"] },
    },
  };
  expect(graph(unknown, ["dev"], {})).toEqual(["migrate"]);
});
