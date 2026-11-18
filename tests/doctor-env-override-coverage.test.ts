import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDoctorJsonData } from "../src/commands/doctor.ts";
import {
  type ComposeEnvEffectiveScopes,
  renderComposeEnvReferenceOverride,
} from "../src/lib/compose-managed-env.ts";
import {
  checkEnvOverrideCoverage,
  ENV_OVERRIDE_COVERAGE_CHECK,
  envOverrideCoverageCheck,
  inspectEnvOverrideCoverage,
  runningComposeServices,
} from "../src/lib/doctor-env-override-coverage.ts";
import { runFixtureGit } from "./helpers/fixture-git.ts";

const FILE = ".hack/.internal/compose.env.override.yml";
const GRAPH = ["api", "web", "worker"];
const ALL = new Set(GRAPH);

/** Global env plus one service scope, with effective scopes as `hack up` passes them. */
function render(targetServices: readonly string[]): string {
  const effectiveScopes: ComposeEnvEffectiveScopes = {
    api: {
      LOG_LEVEL: { scope: "global" },
      API_TOKEN: { scope: "service" },
    },
  };
  const out = renderComposeEnvReferenceOverride({
    targetServices,
    globalEnv: { LOG_LEVEL: "synthetic-global" },
    serviceEnv: {
      api: { LOG_LEVEL: "synthetic-global", API_TOKEN: "synthetic-scoped" },
    },
    effectiveScopes,
  });
  if (!out) {
    throw new Error("expected an override");
  }
  return out.text;
}

test("a whole-graph override covers every running service with managed env", () => {
  const coverage = inspectEnvOverrideCoverage({
    text: render(GRAPH),
    expected: GRAPH,
    managed: ALL,
  });
  expect(coverage).toEqual({ kind: "covered", services: GRAPH, missing: [] });
  expect(
    envOverrideCoverageCheck({ coverage, file: FILE, running: true }).status
  ).toBe("ok");
});

test("an override an older targeted restart wrote misses the other running services", () => {
  const coverage = inspectEnvOverrideCoverage({
    text: render(["api"]),
    expected: ["api", "web", "worker", "web"],
    managed: ALL,
  });
  expect(coverage).toEqual({
    kind: "stale",
    services: ["api"],
    missing: ["web", "worker"],
  });
  const check = envOverrideCoverageCheck({
    coverage,
    file: FILE,
    running: true,
  });
  expect(check.status).toBe("warn");
  expect(check.message).toContain(
    `${FILE} has no entry for 2 running services: web, worker`
  );
  expect(check.message).toContain("Run `hack up` once");
  // Names only: never a value or a reference name.
  expect(check.message).not.toContain("synthetic");
  expect(check.message).not.toContain("HACK_ENV_");
});

test("a service without effective managed env needs no entry", () => {
  // web removed every inherited global key; worker has no env at all.
  const coverage = inspectEnvOverrideCoverage({
    text: render(["api"]),
    expected: GRAPH,
    managed: new Set(["api"]),
  });
  expect(coverage).toEqual({ kind: "covered", services: ["api"], missing: [] });
});

test("an absent, empty or foreign file, or unknown env metadata, is not judged", () => {
  const cases: [string | null, ReadonlySet<string> | null][] = [
    [null, ALL],
    ["", ALL],
    ["not: [yaml\n", ALL],
    ["name: x\n", ALL],
    [render(["api"]), null],
  ];
  for (const [text, managed] of cases) {
    const check = envOverrideCoverageCheck({
      coverage: inspectEnvOverrideCoverage({ text, expected: GRAPH, managed }),
      file: FILE,
      running: true,
    });
    expect([text, check.status]).toEqual([text, "ok"]);
  }
});

test("doctor JSON places the check under env and secrets", () => {
  const check = envOverrideCoverageCheck({
    coverage: inspectEnvOverrideCoverage({
      text: render(["api"]),
      expected: GRAPH,
      managed: ALL,
    }),
    file: FILE,
    running: true,
  });
  const data = buildDoctorJsonData({ results: [{ ...check, durationMs: 1 }] });
  expect(data.checks[0]).toMatchObject({
    id: ENV_OVERRIDE_COVERAGE_CHECK,
    status: "warn",
    area: "env_secrets",
    scope: "project",
  });
});

async function fixture(env: string) {
  const root = await mkdtemp(join(tmpdir(), "doctor-env-override-"));
  await mkdir(join(root, ".hack/.internal"), { recursive: true });
  await runFixtureGit({ cwd: root, args: ["init", "--quiet"] });
  await Bun.write(
    join(root, ".hack/docker-compose.yml"),
    "services:\n  api:\n    image: x:1\n  web:\n    image: x:1\n"
  );
  await Bun.write(join(root, ".hack/hack.env.default.yaml"), env);
  return root;
}

test("without Docker the Compose file's services with managed env are expected", async () => {
  const root = await fixture(
    [
      "version: 1",
      "environment: default",
      "secretsprovider: project_key",
      "values:",
      "  global:",
      '    LOG_LEVEL: "synthetic-global"',
      "",
    ].join("\n")
  );
  try {
    await Bun.write(join(root, FILE), render(["api"]));
    const stale = await checkEnvOverrideCoverage({
      startDir: root,
      dockerOk: false,
    });
    expect(stale.status).toBe("warn");
    expect(stale.message).toContain("has no entry for Compose service web");

    await Bun.write(join(root, FILE), render(["api", "web"]));
    const covered = await checkEnvOverrideCoverage({
      startDir: root,
      dockerOk: false,
    });
    expect(covered.status).toBe("ok");
    expect(covered.message).toContain("running containers not inspected");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a service scope that removes every global key with null needs no entry", async () => {
  const root = await fixture(
    [
      "version: 1",
      "environment: default",
      "secretsprovider: project_key",
      "values:",
      "  global:",
      '    LOG_LEVEL: "synthetic-global"',
      "  web:",
      "    LOG_LEVEL: null",
      "",
    ].join("\n")
  );
  try {
    await Bun.write(join(root, FILE), render(["api"]));
    const check = await checkEnvOverrideCoverage({
      startDir: root,
      dockerOk: false,
    });
    expect(check.status).toBe("ok");
    // Judged and covered, not skipped for unreadable metadata.
    expect(check.message).toContain(
      "covers every Compose service with managed env"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("host lifecycle processes and stopped containers are not expected", () => {
  expect(
    runningComposeServices({
      graph: ["api", "web"],
      containers: [
        { service: "api", state: "running" },
        { service: "web", state: "exited" },
        // A host lifecycle process shows up under its process name.
        { service: "dev-server", state: "running" },
        // A service removed from the Compose file whose container still runs:
        // `hack up` renders the current graph, so it cannot get an entry.
        { service: "old-api", state: "running" },
        // A service from a Compose `include:` file is not in the top-level graph.
        { service: "included-cache", state: "running" },
      ],
    })
  ).toEqual(["api"]);
});
