import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeAuthoredProjectStatus } from "../src/backends/native-authored-project-observe.ts";
import {
  answerNativeAlreadyRunning,
  nativeAuthoredProjectName,
} from "../src/commands/native-up-already-running.ts";

/**
 * HACK-2620. `hack up -d` on an authored (`.hack/hack.project.json`) project
 * that is already running exited 1 with `E_STARTUP_INCOMPLETE`: the launcher
 * asked only the Compose-file run store, launched a child that refused the
 * live generation, and heard no ready. It now answers from the authored
 * read-only status, in the Compose-file path's shape.
 */

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function authoredProject(manifest: string): Promise<string> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-up-authored-"))
  );
  roots.push(root);
  const projectDir = join(root, ".hack");
  await mkdir(projectDir);
  await writeFile(join(projectDir, "hack.project.json"), manifest);
  return root;
}

function status(
  phase: string,
  items: NativeAuthoredProjectStatus["items"]
): NativeAuthoredProjectStatus {
  return {
    backend: "native",
    status: "observed",
    run: "a".repeat(32),
    phase,
    items,
  };
}

const web = {
  service: "web",
  container: "2".repeat(64),
  state: "running",
  health: "healthy",
  exitCode: null,
  readiness: "healthy",
} as const;

async function answer(opts: {
  readonly json: boolean;
  readonly result: NativeAuthoredProjectStatus | Error;
  readonly branch?: string | null;
  readonly env?: string;
}) {
  const projectRoot = await authoredProject(
    JSON.stringify({ name: "authored-fixture" })
  );
  const stdout: string[] = [];
  const write = spyOn(process.stdout, "write").mockImplementation(
    (chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    }
  );
  const observed: unknown[] = [];
  try {
    const code = await answerNativeAlreadyRunning({
      native: {
        binary: "/must-not-run",
        home: join(projectRoot, "home"),
      },
      json: opts.json,
      selection: { path: projectRoot, env: opts.env },
      resolveAuthored: async () => ({
        projectRoot,
        branch: opts.branch ?? null,
      }),
      // The Compose-file resolution refuses authored projects; it must not run.
      resolveProject: () => Promise.reject(new Error("not a Compose project")),
      resolveBranch: () => Promise.reject(new Error("not a Compose project")),
      authoredPs: async (input) => {
        observed.push(input.scope);
        if (opts.result instanceof Error) {
          throw opts.result;
        }
        return opts.result;
      },
    });
    return { code, stdout: stdout.join(""), observed };
  } finally {
    write.mockRestore();
  }
}

test("a ready authored project answers up -d as already running, in the Compose-file JSON shape", async () => {
  const result = await answer({
    json: true,
    result: status("ready-observed", [web]),
  });
  expect(result.code).toBe(0);
  expect(result.observed).toHaveLength(1);
  const reply = JSON.parse(result.stdout);
  expect(reply).toMatchObject({
    ok: true,
    data: {
      action: "up",
      alreadyRunning: true,
      project: "authored-fixture",
      branch: null,
      composeProject: "authored-fixture",
      services: {
        started: ["web"],
        completed: [],
        warming: [],
        stopped: [],
        failed: [],
      },
      readiness: "ready",
    },
  });
  expect(typeof reply.data.durationMs).toBe("number");
});

test("text output says the authored project is already running and names a scoped restart", async () => {
  const result = await answer({
    json: false,
    branch: "feature",
    result: status("ready-observed", [web]),
  });
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Project is already running.");
  expect(result.stdout).toContain("hack restart --path");
  expect(result.stdout).toContain("--branch feature");
});

test("a branch instance reports its branch compose project name", async () => {
  const result = await answer({
    json: true,
    branch: "feature",
    result: status("ready-observed", [web]),
  });
  expect(JSON.parse(result.stdout).data).toMatchObject({
    branch: "feature",
    composeProject: "authored-fixture--feature",
  });
});

test("an authored project that is not running, or whose status is unconfirmed, launches as before", async () => {
  for (const result of [
    {
      backend: "native",
      status: "not_started",
      run: null,
      phase: null,
      items: [],
    },
    { backend: "native", status: "pending", run: null, phase: null, items: [] },
    status("starting", [web]),
    new Error("Native authored status is unconfirmed; values omitted."),
  ] as const) {
    const answered = await answer({ json: true, result });
    expect(answered.code).toBeNull();
    expect(answered.stdout).toBe("");
  }
});

test("a live authored project with a service down is refused with the partial-run reason", async () => {
  await expect(
    answer({
      json: true,
      result: status("ready-observed", [
        web,
        {
          ...web,
          service: "worker",
          state: "exited",
          exitCode: 1,
          readiness: "started",
        },
      ]),
    })
  ).rejects.toMatchObject({ code: "E_STARTUP_INCOMPLETE" });
});

test("an env selection on authored up is left to the authored start, which refuses it", async () => {
  const result = await answer({
    json: true,
    env: "staging",
    result: status("ready-observed", [web]),
  });
  expect(result.code).toBeNull();
  expect(result.observed).toHaveLength(0);
});

test("the authored name is the manifest's name; a missing or unreadable name is not authored", async () => {
  expect(
    await nativeAuthoredProjectName(
      await authoredProject(JSON.stringify({ name: "named" }))
    )
  ).toBe("named");
  for (const manifest of [
    "not json",
    JSON.stringify({}),
    JSON.stringify({ name: "" }),
  ]) {
    expect(
      await nativeAuthoredProjectName(await authoredProject(manifest))
    ).toBeNull();
  }
});
