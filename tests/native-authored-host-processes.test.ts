import { afterAll, expect } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeAuthoredHostDeadlineError } from "../src/backends/native-authored-artifact-error.ts";
import { nativeHookPermitVersion } from "../src/backends/native-authored-hook-journal.ts";
import {
  createNativeAuthoredHostProcesses,
  retireNativeAuthoredHostProcesses,
} from "../src/backends/native-authored-host-processes.ts";
import { withNativeAuthoredProjectAdmission } from "../src/backends/native-authored-project-run.ts";
import { isRecord } from "../src/lib/guards.ts";
import {
  readLifecycleState,
  resolveLifecycleStatePath,
} from "../src/lib/lifecycle-runtime.ts";
import type { NativeEnvironmentPlan } from "../src/lib/native-env-plan-protocol.ts";
import { selectNativeHostLifecycle } from "../src/lib/native-host-lifecycle-contract.ts";
import {
  endLifecycleMuxFixtureGroups,
  writeLifecycleMuxFixture,
} from "./helpers/lifecycle-mux-fixture.ts";
import { isolateMuxTempDir } from "./helpers/mux-temp.ts";
import { createNativeFixtureCases } from "./helpers/native-fixture-cases.ts";

const cases = createNativeFixtureCases({
  label: "Host process fixture",
  defaultTimeoutMs: 20_000,
  settlementBudgetMs: 5000,
});
const fixtureParent = tmpdir();
afterAll(() => cases.drain(), 30_000);
isolateMuxTempDir();
async function fixture() {
  const owner = cases.current();
  const abort = new AbortController();
  owner.onFailure(() => abort.abort());
  const root = await realpath(
    await mkdtemp(join(fixtureParent, "native-host-owner-"))
  );
  owner.root(root);
  const projectDir = join(root, ".hack");
  const bin = join(root, "bin");
  await mkdir(projectDir, { mode: 0o700 });
  await mkdir(bin);
  await writeLifecycleMuxFixture(bin);
  const before = owner.saveEnv([
    "PATH",
    "HACK_SESSIONS_MUX",
    "HACK_TEST_MUX_STATE",
  ]);
  process.umask(0o077);
  process.env.PATH = `${bin}:${before.PATH ?? "/usr/bin:/bin"}`;
  process.env.HACK_SESSIONS_MUX = "tmux";
  const state = join(root, "mux.json");
  process.env.HACK_TEST_MUX_STATE = state;
  owner.onFailure(() => endLifecycleMuxFixtureGroups(state));
  owner.settlement.record({
    kind: "pid-file",
    name: "host process fixture groups",
    path: state,
    group: true,
    emptySettled: true,
    parse: (text) => {
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        return;
      }
      if (!(isRecord(value) && isRecord(value.windows))) {
        return;
      }
      return Object.values(value.windows).flatMap((row: unknown) =>
        isRecord(row) && typeof row.pid === "number" ? [row.pid] : []
      );
    },
  });
  const deadline = performance.now() + 12_000;
  const remaining = () => {
    const value = Math.ceil(deadline - performance.now());
    if (value < 1 || abort.signal.aborted) {
      throw new NativeAuthoredHostDeadlineError();
    }
    return value;
  };
  const scope = {
    projectRoot: root,
    projectDir,
    nativeHome: join(root, "native"),
    branch: null,
  };
  await mkdir(scope.nativeHome, { mode: 0o700 });
  const invocation = {
    command: {
      exec: [
        process.execPath,
        "--no-env-file",
        "-e",
        "await Bun.write('value-seen',process.env.HOST_VALUE??'missing');await Bun.write('endpoint-seen',process.env.HOST_URL??'missing');setInterval(()=>{},1000)",
      ],
    },
    cwd: ".",
    env_target: { kind: "host" },
    environment: {
      HOST_VALUE: { env_ref: "TOKEN" },
      HOST_URL: { endpoint: { kind: "host_binding", name: "api" } },
    },
  };
  const lifecycle = selectNativeHostLifecycle({
    host: { processes: { tunnel: invocation } },
  });
  const report: NativeEnvironmentPlan = {
    plan_version: 1,
    overlay: null,
    overlay_exists: false,
    complete: true,
    workloads: {},
    host: {
      tunnel: {
        env_target: { kind: "host" },
        bindings: {
          HOST_VALUE: {
            kind: "managed",
            key: "TOKEN",
            scope: "host",
            secret: true,
          },
          HOST_URL: {
            kind: "endpoint",
            reference: { kind: "host_binding", name: "api" },
            target: {
              kind: "host",
              context: "host",
              protocol: "http",
              port: 4321,
            },
          },
        },
      },
    },
    warnings: [],
    diagnostics: [],
  };
  return {
    root,
    projectDir,
    scope,
    state,
    abort,
    remaining,
    lifecycle,
    report,
  };
}
const run = "f".repeat(32),
  semantic = "a".repeat(64),
  canary = "synthetic-private-process-value";
function ownedCase(
  name: string,
  action: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>
) {
  cases.test(name, async () => action(await fixture()));
}
ownedCase(
  "Source5 private process proof starts the shipping controller and exact-token stop preserves value privacy",
  async (f) => {
    await withNativeAuthoredProjectAdmission(f.scope, async (admission) => {
      const hooks = await admission.createHooks({
        run,
        selectionHash: semantic,
      });
      const owner = await createNativeAuthoredHostProcesses({
        scope: f.scope,
        run,
        semanticHash: semantic,
        projectName: "fixture",
        lifecycle: f.lifecycle,
        report: () => f.report,
        resolveValues: () => Promise.resolve({ TOKEN: canary }),
        assertFresh: admission.assertHeld,
        signal: f.abort.signal,
        remaining: f.remaining,
      });
      const permit = await hooks.permit({
        role: "preflight",
        semanticHash: semantic,
        processes: await owner.proof(false),
      });
      expect(nativeHookPermitVersion(permit)).toBe(5);
      try {
        await owner.start();
        await owner.assertReady();
        const process = (
          await readLifecycleState({ projectDir: f.projectDir })
        )[0]?.processes[0];
        expect(process?.paneBirth).toBeString();
        expect(process?.processGroupBirth).toBeString();
        expect(await readFile(join(f.root, "value-seen"), "utf8")).toBe(canary);
        expect(await readFile(join(f.root, "endpoint-seen"), "utf8")).toBe(
          "http://127.0.0.1:4321"
        );
        const calls = await readFile(`${f.state}.calls`, "utf8");
        expect(calls).not.toContain(canary);
        expect(calls).not.toContain("set-environment");
        const proof = await owner.proof(true);
        expect(proof.path.endsWith(".host-process-ready.json")).toBe(true);
      } finally {
        await owner.stop();
        await owner.close();
      }
      await hooks.retire();
    });
  }
);
ownedCase(
  "pre-Ready observation refuses live host records without stopping and accepts settled records without retiring",
  async (f) => {
    let unknown = true;
    await withNativeAuthoredProjectAdmission(f.scope, async (admission) => {
      const owner = await createNativeAuthoredHostProcesses({
        scope: f.scope,
        run,
        semanticHash: semantic,
        projectName: "fixture",
        lifecycle: f.lifecycle,
        report: () => f.report,
        resolveValues: () => Promise.resolve({ TOKEN: canary }),
        assertFresh: admission.assertHeld,
        signal: f.abort.signal,
        remaining: f.remaining,
      });
      try {
        await owner.start();
        const calls = await readFile(`${f.state}.calls`, "utf8");
        const check = {
          scope: f.scope,
          run,
          assertFresh: admission.assertHeld,
          checkOnly: true,
        };
        await expect(
          retireNativeAuthoredHostProcesses(check)
        ).rejects.toThrow();
        const later = (await readFile(`${f.state}.calls`, "utf8")).slice(
          calls.length
        );
        expect(later).not.toContain("send-keys");
        expect(later).not.toContain("kill-session");
        await owner.stop();
        await retireNativeAuthoredHostProcesses(check);
        const path = join(
          f.projectDir,
          ".internal/native-authored-runs",
          `${run}.host-process-owner.json`
        );
        expect(await Bun.file(path).exists()).toBe(true);
        await retireNativeAuthoredHostProcesses({ ...check, checkOnly: false });
        expect(await Bun.file(path).exists()).toBe(false);
        // Recovery removed its publication; close still releases the original
        // fixture owner's held directory handles while refusing changed proof.
        await expect(owner.close()).rejects.toThrow();
        unknown = false;
      } finally {
        if (unknown) {
          await owner.stop();
          await owner.close();
          unknown = false;
        }
      }
    });
  }
);

ownedCase(
  "recovery uses the saved exact controller identity and refuses a foreign live token before any stop",
  async (f) => {
    await withNativeAuthoredProjectAdmission(f.scope, async (admission) => {
      const owner = await createNativeAuthoredHostProcesses({
        scope: f.scope,
        run,
        semanticHash: semantic,
        projectName: "fixture",
        lifecycle: f.lifecycle,
        report: () => f.report,
        resolveValues: () => Promise.resolve({ TOKEN: canary }),
        assertFresh: admission.assertHeld,
        signal: f.abort.signal,
        remaining: f.remaining,
      });
      await owner.start();
      const state = await readFile(f.state, "utf8");
      const foreign = JSON.parse(state);
      foreign.token = "foreign";
      await writeFile(f.state, JSON.stringify(foreign));
      const calls = await readFile(`${f.state}.calls`, "utf8");
      await expect(owner.stop()).rejects.toThrow("values omitted");
      const later = (await readFile(`${f.state}.calls`, "utf8")).slice(
        calls.length
      );
      expect(later).not.toContain("send-keys");
      expect(later).not.toContain("kill-session");
      await writeFile(f.state, state);
      await expect(owner.close()).rejects.toThrow("values omitted");
      await retireNativeAuthoredHostProcesses({
        scope: f.scope,
        run,
        assertFresh: admission.assertHeld,
      });
      const metadata = JSON.parse(
        await readFile(
          resolveLifecycleStatePath({ projectDir: f.projectDir }),
          "utf8"
        )
      );
      expect(metadata.entries).toEqual([]);
    });
  }
);
ownedCase(
  "byte-identical ready replacement refuses before stop and the original inode remains recoverable",
  async (f) => {
    await withNativeAuthoredProjectAdmission(f.scope, async (admission) => {
      const owner = await createNativeAuthoredHostProcesses({
        scope: f.scope,
        run,
        semanticHash: semantic,
        projectName: "fixture",
        lifecycle: f.lifecycle,
        report: () => f.report,
        resolveValues: () => Promise.resolve({ TOKEN: canary }),
        assertFresh: admission.assertHeld,
        signal: f.abort.signal,
        remaining: f.remaining,
      });
      await owner.start();
      const proof = await owner.proof(true);
      const original = `${proof.path}.preserved`;
      const bytes = await readFile(proof.path);
      await rename(proof.path, original);
      await writeFile(proof.path, bytes, { flag: "wx", mode: 0o600 });
      const calls = await readFile(`${f.state}.calls`, "utf8");
      await expect(owner.assertReady()).rejects.toThrow("values omitted");
      await expect(owner.stop()).rejects.toThrow("values omitted");
      const later = (await readFile(`${f.state}.calls`, "utf8")).slice(
        calls.length
      );
      expect(later).not.toContain("send-keys");
      expect(later).not.toContain("kill-session");
      await rm(proof.path);
      await rename(original, proof.path);
      // Rename changes ctime, so the old live owner conservatively retains its proof.
      await expect(owner.close()).rejects.toThrow("values omitted");
      await retireNativeAuthoredHostProcesses({
        scope: f.scope,
        run,
        assertFresh: admission.assertHeld,
      });
    });
  }
);
ownedCase(
  "cancellation during values refuses before mux effects and keeps the original no-replay boundary",
  async (f) => {
    await withNativeAuthoredProjectAdmission(f.scope, async (admission) => {
      const owner = await createNativeAuthoredHostProcesses({
        scope: f.scope,
        run,
        semanticHash: semantic,
        projectName: "fixture",
        lifecycle: f.lifecycle,
        report: () => f.report,
        resolveValues: () => {
          f.abort.abort();
          return Promise.resolve({ TOKEN: canary });
        },
        assertFresh: admission.assertHeld,
        signal: f.abort.signal,
        remaining: f.remaining,
      });
      await expect(owner.start()).rejects.toThrow("expired");
      await owner.stop();
      await owner.close();
      await expect(readFile(`${f.state}.calls`, "utf8")).rejects.toThrow();
    });
  }
);

ownedCase(
  "cancellation with a missing launch birth still ends the owned native mux session",
  async (f) => {
    const ps = Bun.which("ps");
    expect(ps).not.toBeNull();
    const held = join(f.root, "launch-census-held");
    const release = join(f.root, "launch-census-release");
    await writeFile(
      join(f.root, "bin", "ps"),
      `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "-A" && !(await Bun.file(${JSON.stringify(held)}).exists())) {
  await Bun.write(${JSON.stringify(held)}, "held");
  const deadline = performance.now() + 10_000;
  while (!(await Bun.file(${JSON.stringify(release)}).exists()) && performance.now() < deadline) await Bun.sleep(10);
  process.exit(0);
}
const child = Bun.spawn([${JSON.stringify(ps)}, ...args], {stdin:"ignore", stdout:"inherit", stderr:"inherit"});
process.exit(await child.exited);
`,
      { mode: 0o700 }
    );
    let muxStopped = false;
    let stateRemoved = false;
    let startupInputsCanceled = false;
    let cleanupChecks = 0;
    const outcome = await withNativeAuthoredProjectAdmission(
      f.scope,
      async (admission) => {
        const owner = await createNativeAuthoredHostProcesses({
          scope: f.scope,
          run,
          semanticHash: semantic,
          projectName: "fixture",
          lifecycle: f.lifecycle,
          report: () => f.report,
          resolveValues: () => Promise.resolve({ TOKEN: canary }),
          assertFresh: async () => {
            if (startupInputsCanceled) {
              throw new Error("startup input authority was canceled");
            }
            await admission.assertHeld();
          },
          assertCleanupFresh: async () => {
            cleanupChecks += 1;
            await admission.assertHeld();
          },
          signal: f.abort.signal,
          remaining: f.remaining,
        });
        const starting = owner.start().catch((error: unknown) => error);
        try {
          const deadline = performance.now() + 10_000;
          while (
            !(await Bun.file(held).exists()) &&
            performance.now() < deadline
          ) {
            await Bun.sleep(10);
          }
          expect(await Bun.file(held).exists()).toBe(true);
          startupInputsCanceled = true;
          f.abort.abort();
          await Bun.write(release, "released");
          expect(await starting).toBeInstanceOf(Error);
          // The launch's aborted deadline must not veto owned teardown when
          // the new cleanup path needs to retry missing start-time metadata.
          muxStopped = !(await Bun.file(f.state).exists());
          stateRemoved =
            (await readLifecycleState({ projectDir: f.projectDir })).length ===
            0;
          if (muxStopped && stateRemoved) {
            // The frontend refreshes teardown inputs after the launch settles.
            startupInputsCanceled = false;
            await owner.stop();
            await owner.close();
          }
        } finally {
          await Bun.write(release, "released");
          await starting;
          await endLifecycleMuxFixtureGroups(f.state);
        }
      }
    ).catch((error: unknown) => error);
    expect(
      muxStopped,
      "canceled launch must stop its owned mux despite a missing birth"
    ).toBe(true);
    expect(stateRemoved).toBe(true);
    expect(cleanupChecks).toBeGreaterThan(0);
    expect(outcome).toBeUndefined();
  }
);
