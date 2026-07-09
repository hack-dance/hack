import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  resolveRestartTarget,
  resolveStoredRuntimeEnvName,
} from "../src/commands/project.ts";

const tempDirs = new Set<string>();

afterEach(async () => {
  for (const tempDir of tempDirs) {
    await rm(tempDir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

test("restart reuses the persisted runtime env selection when --env is omitted", async () => {
  const projectDir = await createProjectDirWithRuntimeState({
    composeProject: "restart-env",
    envName: "docker",
  });

  const resolved = await resolveStoredRuntimeEnvName({
    requestedEnvName: undefined,
    projectDir,
    composeProject: "restart-env",
  });

  expect(resolved).toBe("docker");
});

test("restart honors an explicit --env over stored runtime state", async () => {
  const projectDir = await createProjectDirWithRuntimeState({
    composeProject: "restart-env",
    envName: "docker",
  });

  const resolved = await resolveStoredRuntimeEnvName({
    requestedEnvName: "staging",
    projectDir,
    composeProject: "restart-env",
  });

  expect(resolved).toBe("staging");
});

test("restart preserves an explicit base env selection over stored runtime state", async () => {
  const projectDir = await createProjectDirWithRuntimeState({
    composeProject: "restart-env",
    envName: "docker",
  });

  const resolved = await resolveStoredRuntimeEnvName({
    requestedEnvName: null,
    projectDir,
    composeProject: "restart-env",
  });

  expect(resolved).toBeNull();
});

test("restart from the primary checkout targets only the base compose instance", () => {
  expect(
    resolveRestartTarget({
      baseProjectName: "event-agent",
      branch: null,
    })
  ).toEqual({
    composeProjectName: null,
    lifecycleComposeProject: "event-agent",
  });
});

test("restart with an explicit branch targets only that branch instance", () => {
  expect(
    resolveRestartTarget({
      baseProjectName: "event-agent",
      branch: "feat-msp-human-handoff",
    })
  ).toEqual({
    composeProjectName: "event-agent--feat-msp-human-handoff",
    lifecycleComposeProject: "event-agent--feat-msp-human-handoff",
  });
});

async function createProjectDirWithRuntimeState(opts: {
  readonly composeProject: string;
  readonly envName: string | null;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hack-restart-env-"));
  tempDirs.add(root);
  const projectDir = resolve(root, ".hack");
  const internalDir = resolve(projectDir, ".internal");

  await mkdir(internalDir, { recursive: true });
  await writeFile(
    resolve(internalDir, "runtime-state.json"),
    `${JSON.stringify(
      {
        entries: [
          {
            composeProject: opts.composeProject,
            envName: opts.envName,
            updatedAt: "2026-03-26T00:00:00.000Z",
          },
        ],
      },
      null,
      2
    )}\n`
  );

  return projectDir;
}
