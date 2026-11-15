import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
  PROJECT_ENV_FILENAME,
} from "../src/constants.ts";
import { resolveLifecycleRunner } from "../src/lib/lifecycle-runner.ts";
import { readProjectConfig } from "../src/lib/project.ts";
import { renderProjectConfigSchemaJson } from "../src/templates.ts";

async function config(value: unknown) {
  const root = await mkdtemp(join(tmpdir(), "hack-runner-config-"));
  try {
    const projectRoot = join(root, "repo");
    const projectDir = join(projectRoot, ".hack");
    await mkdir(projectDir, { recursive: true });
    const configFile = join(projectDir, PROJECT_CONFIG_FILENAME);
    const composeFile = join(projectDir, PROJECT_COMPOSE_FILENAME);
    const envFile = join(projectDir, PROJECT_ENV_FILENAME);
    await writeFile(configFile, JSON.stringify(value));
    await writeFile(composeFile, "services: {}\n");
    await writeFile(envFile, "");
    return await readProjectConfig({
      projectRoot,
      projectDir,
      projectDirName: ".hack",
      composeFile,
      configFile,
      envFile,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("runner-only lifecycle config is retained", async () => {
  const cfg = await config({ lifecycle: { runner: "supervisor" } });
  expect(cfg.lifecycle).toEqual({ runner: "supervisor" });
  expect(cfg.lifecycleRunnerError).toBeUndefined();
});

test("startup merging preserves runner and command ordering", async () => {
  const cfg = await config({
    lifecycle: {
      runner: "supervisor",
      up: { before: ["echo before"] },
      processes: [{ name: "existing", command: "example-worker" }],
    },
    startup: [
      "echo shorthand",
      { name: "additional", run: "example-helper", persistent: true },
    ],
  });
  expect(cfg.lifecycle?.runner).toBe("supervisor");
  expect(cfg.lifecycle?.up?.before).toEqual([
    { command: "echo before" },
    { command: "echo shorthand" },
  ]);
  expect(cfg.lifecycle?.processes).toEqual([
    { name: "existing", command: "example-worker" },
    { name: "additional", command: "example-helper" },
  ]);
});

test("omitted runner defaults to mux without changing parsed config", async () => {
  const cfg = await config({
    startup: [{ run: "example-worker", persistent: true }],
  });
  expect(cfg.lifecycle?.runner).toBeUndefined();
  expect(
    resolveLifecycleRunner({ runner: cfg.lifecycle?.runner, env: {} })
  ).toBe("mux");
  expect(resolveLifecycleRunner({ env: {} })).toBe("mux");
});

test("environment override precedes either configured runner", () => {
  expect(
    resolveLifecycleRunner({
      runner: "mux",
      env: { HACK_LIFECYCLE_RUNNER: "supervisor" },
    })
  ).toBe("supervisor");
  expect(
    resolveLifecycleRunner({
      runner: "supervisor",
      env: { HACK_LIFECYCLE_RUNNER: "mux" },
    })
  ).toBe("mux");
});

test.each([
  "",
  "auto",
  "SUPERVISOR",
  "synthetic-invalid-input",
  null,
  7,
])("invalid explicit runner config is marked for fail-closed startup (%p)", async (runner) => {
  const cfg = await config({
    lifecycle: { runner },
    startup: ["echo preparation"],
  });
  expect(cfg.lifecycleRunnerError).toContain("lifecycle.runner");
  expect(cfg.lifecycleRunnerError).toContain('"mux" or "supervisor"');
  expect(cfg.parseError).toContain(
    cfg.lifecycleRunnerError ?? "missing-validation"
  );
  expect(cfg.lifecycleRunnerError).not.toContain("synthetic-invalid-input");
  expect(cfg.lifecycle?.up?.before).toEqual([{ command: "echo preparation" }]);
  expect(() => resolveLifecycleRunner({ runner, env: {} })).toThrow(
    "lifecycle.runner"
  );
});

test.each([
  "",
  "auto",
  "SUPERVISOR",
  "synthetic-invalid-input",
])("invalid explicit environment override never falls back (%p)", (override) => {
  expect(() =>
    resolveLifecycleRunner({
      runner: "mux",
      env: { HACK_LIFECYCLE_RUNNER: override },
    })
  ).toThrow("HACK_LIFECYCLE_RUNNER");
  try {
    resolveLifecycleRunner({
      runner: "mux",
      env: { HACK_LIFECYCLE_RUNNER: override },
    });
  } catch (error: unknown) {
    expect(error instanceof Error && error.message).not.toContain(
      "synthetic-invalid-input"
    );
  }
});

test("runner schema accepts only the named options and documents mux default", () => {
  const schema = JSON.parse(renderProjectConfigSchemaJson());
  expect(schema.properties.lifecycle.properties.runner).toMatchObject({
    type: "string",
    enum: ["mux", "supervisor"],
    default: "mux",
  });
});

test("runner-only config survives shorthand and shared-helper reconstruction", async () => {
  const cfg = await config({
    lifecycle: {
      runner: "mux",
      sharedHelpers: [
        {
          name: "example-helper",
          command: ["example-helper"],
          port: 4100,
          upstream: "https://example.invalid",
        },
      ],
    },
    startup: ["echo preparation"],
  });
  expect(cfg.lifecycle?.runner).toBe("mux");
  expect(cfg.lifecycle?.sharedHelpers).toHaveLength(1);
  expect(cfg.lifecycle?.up?.before).toEqual([{ command: "echo preparation" }]);
});
