import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findDoctorAdoptedProject } from "../src/lib/doctor-adopted-project.ts";
import { selectLegacyComposeAdoptedRoot } from "../src/lib/native-compose-adoption-command.ts";
import { inspectLegacyComposeAdoptionSelection } from "../src/lib/native-compose-adoption-marker.ts";
import { expectCodedRefusal } from "./helpers/closed-refusal.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";
import {
  retainedSourceBindFixture,
  SOURCE_BIND_CANARY,
} from "./helpers/retained-source-bind-adoption.ts";

/**
 * HACK-1380: project commands look for an adoption before ordinary discovery.
 * That search once stopped after 64 directories and then refused the command
 * as an unsupported adopted command (`E_NATIVE_PROJECT_UNSUPPORTED`), even
 * with no project at all. It now walks as far as ordinary discovery does, so
 * a start directory 70 levels deep behaves like a shallow one: no project
 * gets the ordinary missing-project error, an adoption above is still
 * selected, and unsafe adoption state is still refused (`E_CONFIG_INVALID`).
 *
 * The CLI runs in a private HOME and HACK_HOME with no Docker client config;
 * the adopted cases use the synthetic retained source-bind engine only.
 */

/** More directory levels than the old 64-directory search covered. */
const DEPTH = 70;

/** Commands that reach the adoption search through native dispatch or open. */
const COMMANDS: readonly (readonly string[])[] = [
  ["ps"],
  ["up", "--detach"],
  ["down"],
  ["logs", "--no-follow"],
  ["open"],
];

async function deepDirectory(base: string): Promise<string> {
  let deep = base;
  for (let level = 0; level < DEPTH; level++) {
    deep = join(deep, "d");
  }
  await mkdir(deep, { recursive: true });
  return deep;
}

type CliRun = { readonly exit: number; readonly output: string };

/** Runs the source CLI from `cwd` with private state under `root`. */
async function cli(opts: {
  readonly root: string;
  readonly cwd: string;
  readonly args: readonly string[];
}): Promise<CliRun> {
  const state = join(opts.root, "state");
  await mkdir(state, { recursive: true });
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "..", "index.ts"),
      ...opts.args,
    ],
    {
      cwd: opts.cwd,
      env: privateCliEnv({
        root: opts.root,
        env: {
          HACK_HOME: state,
          HACK_GLOBAL_CONFIG_PATH: join(state, "hack.config.json"),
          HACK_DAEMON_DISABLE: "1",
          HACK_NO_INTERACTIVE: "1",
          HACK_LOGGER: "console",
          HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK: "1",
          XDG_CACHE_HOME: join(opts.root, "cache"),
          // The adopted fixture's synthetic engine is `<root>/docker`; with no
          // fixture there, no `docker` resolves at all.
          PATH: `${opts.root}:/usr/bin:/bin`,
        },
      }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exit, output: stdout + stderr };
}

/** Prepares and publishes the fixture's adoption. */
async function adopt(
  h: Awaited<ReturnType<typeof retainedSourceBindFixture>>
): Promise<void> {
  const store = await h.store();
  try {
    const generation = await store.prepare({ binary: h.compiler });
    await store.publish({ generation, binary: h.compiler });
  } finally {
    await store.close();
  }
}

/**
 * Leaves the published adoption pending: a retained `start` whose callback
 * reports failure keeps its journal. The callback runs no engine command.
 */
async function leavePending(
  h: Awaited<ReturnType<typeof retainedSourceBindFixture>>
): Promise<void> {
  const store = await h.store();
  try {
    const active = await store.loadActive();
    if (!active) {
      throw new Error("Synthetic active generation missing; values omitted.");
    }
    const outcome = await store.withMutation({
      generation: active,
      operation: "start",
      services: [],
      binary: h.compiler,
      deadline: Date.now() + 15_000,
      run: async () => 1,
    });
    if (outcome !== 1) {
      throw new Error("Synthetic failed operation completed; values omitted.");
    }
  } finally {
    await store.close();
  }
}

test("a project command 70 directories deep with no project gets the ordinary missing-project error, not an adopted refusal", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "adoption-search-depth-"))
  );
  try {
    const shallow = join(root, "shallow", "d");
    await mkdir(shallow, { recursive: true });
    const deep = await deepDirectory(join(root, "deep"));

    expect(await selectLegacyComposeAdoptedRoot({ cwd: deep })).toBeNull();
    expect(await findDoctorAdoptedProject({ startDir: deep })).toBeNull();

    for (const args of COMMANDS) {
      const expected = await cli({ root, cwd: shallow, args });
      const actual = await cli({ root, cwd: deep, args });
      expect({ args, ...actual }).toEqual({ args, ...expected });
      expect(actual.exit).toBe(1);
      expect(actual.output).toContain("No .hack/ (or legacy .dev/) found");
      expect(actual.output).not.toContain("E_NATIVE_PROJECT_UNSUPPORTED");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test("an active adoption more than 64 directories above the start directory is still selected", async () => {
  const h = await retainedSourceBindFixture();
  try {
    await adopt(h);
    const shallow = join(h.root, "source");
    const deep = await deepDirectory(shallow);

    expect(await selectLegacyComposeAdoptedRoot({ cwd: deep })).toBe(h.root);
    expect(await findDoctorAdoptedProject({ startDir: deep })).toMatchObject({
      projectRoot: h.root,
      state: "active",
    });

    // ps lists the retained container from either depth.
    const ps = await cli({ root: h.outer, cwd: deep, args: ["ps"] });
    expect(ps).toEqual({ exit: 0, output: "db\texited\n" });
    expect(ps).toEqual(
      await cli({ root: h.outer, cwd: shallow, args: ["ps"] })
    );
    // up stays on the adopted path from depth too: ordinary discovery reads
    // an active adoption as native input, so a missed adoption would reach
    // native startup instead.
    const up = ["up", "--detach"];
    expect(await cli({ root: h.outer, cwd: deep, args: up })).toEqual(
      await cli({ root: h.outer, cwd: shallow, args: up })
    );
    expect(
      await inspectLegacyComposeAdoptionSelection({ projectRoot: h.root })
    ).toBe("active");
  } finally {
    await h.cleanup();
  }
}, 120_000);

test("a pending adoption more than 64 directories above the start directory still asks for explicit recovery", async () => {
  const h = await retainedSourceBindFixture();
  try {
    await adopt(h);
    await leavePending(h);
    const shallow = join(h.root, "source");
    const deep = await deepDirectory(shallow);

    expect(await selectLegacyComposeAdoptedRoot({ cwd: deep })).toBe(h.root);
    expect(await findDoctorAdoptedProject({ startDir: deep })).toMatchObject({
      projectRoot: h.root,
      state: "pending",
    });
    for (const args of [["ps"], ["down"]]) {
      const actual = await cli({ root: h.outer, cwd: deep, args });
      expect(actual).toEqual(await cli({ root: h.outer, cwd: shallow, args }));
      expect(actual.exit).toBe(1);
      expect(actual.output).toContain("E_CONFIG_INVALID");
      expect(actual.output).not.toContain(SOURCE_BIND_CANARY);
    }
    expect(
      await inspectLegacyComposeAdoptionSelection({ projectRoot: h.root })
    ).toBe("pending");
  } finally {
    await h.cleanup();
  }
}, 120_000);

test("unsafe adoption state more than 64 directories above the start directory is still refused, closed and value-free", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "adoption-search-depth-"))
  );
  try {
    // An adoption state root that is a file is unsafe adoption state.
    const project = join(root, "unsafe");
    await mkdir(join(project, ".hack/.internal"), { recursive: true });
    await writeFile(
      join(project, ".hack/.internal/legacy-compose-adoption-v1"),
      SOURCE_BIND_CANARY
    );
    const deep = await deepDirectory(project);

    const error = await expectCodedRefusal(
      selectLegacyComposeAdoptedRoot({ cwd: deep }),
      "E_CONFIG_INVALID",
      "values omitted"
    );
    expect(String(error)).not.toContain(SOURCE_BIND_CANARY);
    expect(String(error)).not.toContain(project);

    const run = await cli({ root, cwd: deep, args: ["ps"] });
    expect(run.exit).toBe(1);
    expect(run.output).toContain("E_CONFIG_INVALID");
    expect(run.output).not.toContain("E_NATIVE_PROJECT_UNSUPPORTED");
    expect(run.output).not.toContain(SOURCE_BIND_CANARY);
    expect(run.output).not.toContain(project);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
