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
} from "../src/lib/doctor-env-override-coverage.ts";
import { runFixtureGit } from "./helpers/fixture-git.ts";

const FILE = ".hack/.internal/compose.env.override.yml";
const GRAPH = ["api", "web", "worker"];

/** Global env plus one service scope, with effective scopes as `hack up` passes them. */
function render(targetServices: readonly string[]): string {
  const globalEnv = { LOG_LEVEL: "synthetic-global" };
  const serviceEnv = {
    api: { LOG_LEVEL: "synthetic-global", API_TOKEN: "synthetic-scoped" },
  };
  const effectiveScopes: ComposeEnvEffectiveScopes = {
    api: {
      LOG_LEVEL: { scope: "global" },
      API_TOKEN: { scope: "service" },
    },
  };
  const out = renderComposeEnvReferenceOverride({
    targetServices,
    globalEnv,
    serviceEnv,
    effectiveScopes,
  });
  if (!out) {
    throw new Error("expected an override");
  }
  return out.text;
}

test("a whole-graph override covers every running service", () => {
  const coverage = inspectEnvOverrideCoverage({
    text: render(GRAPH),
    expected: GRAPH,
  });
  expect(coverage).toEqual({
    kind: "covered",
    services: GRAPH,
    missing: [],
  });
  expect(
    envOverrideCoverageCheck({ coverage, file: FILE, running: true }).status
  ).toBe("ok");
});

test("an override an older targeted restart wrote misses the other running services", () => {
  const coverage = inspectEnvOverrideCoverage({
    text: render(["api"]),
    expected: ["api", "web", "worker", "web"],
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

test("without global env a missing service may have no managed env, so nothing is judged", () => {
  const out = renderComposeEnvReferenceOverride({
    targetServices: GRAPH,
    globalEnv: {},
    serviceEnv: { api: { API_TOKEN: "synthetic-scoped" } },
    effectiveScopes: { api: { API_TOKEN: { scope: "service" } } },
  });
  const coverage = inspectEnvOverrideCoverage({
    text: out?.text ?? null,
    expected: GRAPH,
  });
  expect(coverage).toEqual({ kind: "no_global_env", services: ["api"] });
  expect(
    envOverrideCoverageCheck({ coverage, file: FILE, running: true }).status
  ).toBe("ok");
});

test("an absent, empty or foreign file is not judged", () => {
  for (const text of [null, "", "not: [yaml\n", "name: x\n"]) {
    const check = envOverrideCoverageCheck({
      coverage: inspectEnvOverrideCoverage({ text, expected: GRAPH }),
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

test("without Docker the check compares the Compose file's services", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-env-override-"));
  try {
    await mkdir(join(root, ".hack/.internal"), { recursive: true });
    await runFixtureGit({ cwd: root, args: ["init", "--quiet"] });
    await Bun.write(
      join(root, ".hack/docker-compose.yml"),
      "services:\n  api:\n    image: x:1\n  web:\n    image: x:1\n"
    );
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
    expect(covered).toMatchObject({ status: "ok" });
    expect(covered.message).toContain("running containers not inspected");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
