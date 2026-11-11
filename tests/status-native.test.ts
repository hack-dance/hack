import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeProjectPsResult } from "../src/backends/native-project-observe.ts";
import { resolveNativeRuntimeSelection } from "../src/backends/native-runtime-client.ts";
import { CliUsageError } from "../src/cli/command.ts";
import { __testOnlyProjectsCommand } from "../src/commands/projects.ts";
import { ProjectInputSelectionError } from "../src/lib/project-input-selection.ts";

const { runNativeStatus } = __testOnlyProjectsCommand;
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

/** A Compose-shaped project checkout with no native run mapping and no git repository. */
async function projectFixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "hack-status-native-"))
  );
  roots.push(root);
  await mkdir(join(root, ".hack"), { mode: 0o700 });
  await Bun.write(
    join(root, ".hack", "docker-compose.yml"),
    "services:\n  web:\n    image: example/web:1\n"
  );
  const nativeHome = join(root, "native-home");
  await mkdir(nativeHome, { mode: 0o700 });
  return { root, nativeHome };
}

const observed: NativeProjectPsResult = {
  backend: "native",
  status: "observed",
  run: "a".repeat(32),
  phase: "ready-observed",
  items: [
    {
      service: "web",
      container: "1".repeat(64),
      phase: "started",
      state: "running",
      health: "healthy",
      exitCode: null,
    },
  ],
};

async function captureStdout(body: () => Promise<void>): Promise<string> {
  const original = process.stdout.write;
  let out = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    await body();
  } finally {
    process.stdout.write = original;
  }
  return out;
}

test("hack status under native selection observes the cwd project like native ps (HACK-1988)", async () => {
  const { root, nativeHome } = await projectFixture();
  const native = { binary: "/opt/candidate/hack-native", home: nativeHome };
  const scopes: unknown[] = [];
  const out = await captureStdout(async () => {
    const code = await runNativeStatus({
      cwd: root,
      native,
      projectOpt: undefined,
      json: true,
      authored: async () => null,
      ps: async (opts) => {
        scopes.push({ runtime: opts.runtime, scope: opts.scope });
        return observed;
      },
    });
    expect(code).toBe(0);
  });
  // Exactly one bounded native observation, scoped to the project and the base instance.
  expect(scopes).toEqual([
    {
      runtime: native,
      scope: {
        projectRoot: root,
        projectDir: join(root, ".hack"),
        nativeHome,
        branch: null,
      },
    },
  ]);
  // The JSON envelope matches native `hack ps --json`; nothing reports "stopped".
  const parsed = JSON.parse(out) as {
    ok: boolean;
    data: NativeProjectPsResult;
  };
  expect(parsed.ok).toBe(true);
  expect(parsed.data).toEqual(observed);
  expect(out).not.toContain("stopped");
});

test("hack status under native selection refuses outside a project instead of listing Compose state", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "hack-status-native-empty-"))
  );
  roots.push(root);
  let observations = 0;
  await expect(
    runNativeStatus({
      cwd: root,
      native: { binary: "/opt/candidate/hack-native", home: root },
      projectOpt: undefined,
      json: false,
      authored: async () => null,
      ps: async () => {
        observations++;
        return observed;
      },
    })
  ).rejects.toBeInstanceOf(CliUsageError);
  await expect(
    runNativeStatus({
      cwd: root,
      native: { binary: "/opt/candidate/hack-native", home: root },
      projectOpt: undefined,
      json: false,
      authored: async () => null,
      ps: async () => observed,
    })
  ).rejects.toThrow("Run it inside a project or pass --project <name>.");
  expect(observations).toBe(0);
});

test("without HACK_RUNTIME_BACKEND=native, status keeps the Compose listing path", () => {
  expect(resolveNativeRuntimeSelection({})).toBeNull();
  expect(
    resolveNativeRuntimeSelection({ HACK_RUNTIME_BACKEND: "compose" })
  ).toBeNull();
});

test("hack status under native selection dispatches a native-authored project like hack ps", async () => {
  const { root, nativeHome } = await projectFixture();
  // Authored inputs: legacy discovery refuses this checkout.
  await rm(join(root, ".hack", "docker-compose.yml"));
  await Bun.write(
    join(root, ".hack", "hack.project.json"),
    JSON.stringify({ schema_version: 1, name: "status-authored" })
  );
  const native = { binary: "/opt/candidate/hack-native", home: nativeHome };
  const dispatched: unknown[] = [];
  let observations = 0;
  const code = await runNativeStatus({
    cwd: root,
    native,
    projectOpt: undefined,
    json: true,
    authored: async (input) => {
      dispatched.push(input);
      return 7;
    },
    ps: async () => {
      observations++;
      return observed;
    },
  });
  // The authored observer's exit code is the result; the legacy path never runs.
  expect(code).toBe(7);
  expect(observations).toBe(0);
  expect(dispatched).toEqual([
    { cwd: root, project: undefined, operation: "ps", json: true },
  ]);
  // Control: without the authored dispatch this checkout is refused before any observation.
  await expect(
    runNativeStatus({
      cwd: root,
      native,
      projectOpt: undefined,
      json: true,
      authored: async () => null,
      ps: async () => observed,
    })
  ).rejects.toBeInstanceOf(ProjectInputSelectionError);
});
